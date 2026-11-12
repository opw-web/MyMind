//! Explicit deletion grammar. Model assistance can confirm only an independently grounded identity.
use crate::{
    dates::date,
    pending_draft::record,
    schema::{Action, Change, Entity},
};
use anyhow::{Result, anyhow, bail, ensure};
use chrono::{Days, NaiveDate};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

macro_rules! rx {
    ($pattern:literal) => {{
        static REGEX: std::sync::LazyLock<regex::Regex> =
            std::sync::LazyLock::new(|| regex::Regex::new($pattern).unwrap());
        &*REGEX
    }};
}
pub(crate) use rx;

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub(crate) struct Target {
    pub entity: Entity,
    pub id: String,
    pub title: String,
}

impl Target {
    fn key(&self) -> String {
        format!("{}:{}", self.entity.name(), self.id)
    }
}

pub(crate) fn targets(snapshot: &Value) -> Vec<Target> {
    Entity::ALL
        .into_iter()
        .flat_map(|entity| {
            snapshot[entity.table()]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(move |item| {
                    Some(Target {
                        entity,
                        id: item["id"].as_str()?.into(),
                        title: item["title"].as_str()?.into(),
                    })
                })
        })
        .collect()
}

fn kind(text: &str) -> Option<Entity> {
    Some(
        match text.to_ascii_lowercase().trim_start_matches("calendar ") {
            "task" | "tasks" => Entity::Task,
            "event" | "events" | "session" | "sessions" => Entity::Event,
            "project" | "projects" => Entity::Project,
            "section" | "sections" => Entity::Section,
            "category" | "categories" => Entity::Category,
            _ => return None,
        },
    )
}

fn planner(target: &Target) -> bool {
    matches!(target.entity, Entity::Task | Entity::Event)
}

pub(crate) fn normalize(text: &str) -> String {
    let mut out = String::new();
    let mut space = false;
    for ch in text.chars().flat_map(char::to_lowercase) {
        if ch.is_alphanumeric() || matches!(ch, '\'' | '’' | '‘') {
            if space && !out.is_empty() {
                out.push(' ');
            }
            space = false;
            out.push(if matches!(ch, '’' | '‘') {
                '\''
            } else {
                ch
            });
        } else {
            space = true;
        }
    }
    out
}

fn alias(text: &str) -> String {
    rx!(r"^(?:the\s+)?apply for\s+|^(?:the|a|an)\s+")
        .replace(&normalize(text), "")
        .into_owned()
}

fn spoken(text: &str) -> Vec<String> {
    let digits = [
        "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    ];
    alias(text)
        .split_whitespace()
        .map(|word| {
            digits
                .iter()
                .position(|digit| *digit == word)
                .map_or_else(|| word.to_owned(), |i| i.to_string())
        })
        .collect()
}

fn dictation_matches(name: &str, title: &str) -> bool {
    let a = spoken(name);
    let b = spoken(title);
    if a == b {
        return true;
    }
    let (short, long) = if a.len() < b.len() {
        (&a, &b)
    } else {
        (&b, &a)
    };
    long.len() == short.len() + 1
        && (0..short.len()).any(|i| {
            short[..i] == long[..i]
                && short[i] == format!("{}{}", long[i], long[i + 1])
                && short[i + 1..] == long[i + 2..]
        })
}

fn unquote(text: &str) -> &str {
    text.strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .or_else(|| text.strip_prefix('“').and_then(|s| s.strip_suffix('”')))
        .unwrap_or(text)
}

fn pointer(text: &str) -> bool {
    rx!(r"(?i)^(?:it|them|selected|(?:the )?selected (?:one|item)|(?:this|that|these|those)(?: (?:one|ones|item|items|tasks?|events?|sessions?))?)$").is_match(text)
}

fn command(fragment: &str) -> Option<(bool, usize)> {
    let verb = rx!(r"(?i)^(?:(?:just\s+)?(?:delete|remove|erase)|keep|leave|spare|(?:do not|don['’]t|never)\s+(?:delete|remove|erase)|except|not)\b")
        .find(fragment)?;
    Some((
        rx!(r"(?i)^(?:just\s+)?(?:delete|remove|erase)\b").is_match(verb.as_str()),
        verb.end(),
    ))
}

fn emphasis(text: &str) -> bool {
    rx!(r"(?i)^just\s+(?:delete|remove|erase)(?:\s+(?:it|them))?$").is_match(text)
}

fn association(phrase: &str) -> Option<regex::Captures<'_>> {
    let phrase = rx!(r"(?i)^including\s+")
        .find(phrase)
        .map_or(phrase, |m| &phrase[m.end()..]);
    let captures = rx!(r"(?i)^(?:(?:all|every|any|the|both)\s+)?(?:(its|their)\s+)?(?:(linked|associated)\s+)?(?:calendar\s+)?(?:events?|sessions?|blocks?)(?:\s+(?:associated with|linked to|for|of)\s+(.+))?$").captures(phrase)?;
    (1..=3)
        .any(|n| captures.get(n).is_some())
        .then_some(captures)
}

fn each_task(phrase: &str) -> bool {
    rx!(r"(?i)^each\s+task$").is_match(phrase)
}

fn named_clause(phrase: &str) -> bool {
    !phrase.is_empty()
        && !rx!(r"(?i)^(?:all|every|both|this|that|these|those|it|them|selected|the selected|including|do the same)\b").is_match(phrase)
        && !rx!(r"(?i)^(?:the |my )?(?:tasks?|events?|calendar events?|sessions?)$").is_match(phrase)
        && association(phrase).is_none()
}

fn clauses(text: &str) -> Vec<String> {
    let mut quotes = Vec::new();
    let hidden = rx!(r#"[\"“][^\"”]+[\"”]"#).replace_all(text, |c: &regex::Captures<'_>| {
        quotes.push(c[0].to_owned());
        format!("\u{1}{}\u{2}", quotes.len() - 1)
    });
    let inline = rx!(r"(?i)(\b(?:tasks?|(?:calendar )?(?:events?|sessions?)|projects?|sections?|categor(?:y|ies)|blocks?))\s+((?:just\s+)?(?:delete|remove|erase)|keep|leave|spare|(?:do not|don['’]t|never)\s+(?:delete|remove|erase)|do the same (?:with|for|to))\b")
        .replace_all(&hidden, "$1, $2");
    let inline = rx!(r"(?i)\s+(just\s+(?:delete|remove|erase)(?:\s+(?:it|them))?)(\s+(?:and|but|then)\b|\s*[,.;!?\n]|$)")
        .replace_all(&inline, ", $1$2");
    let separated = rx!(r"(?i)\b(except|or)\b").replace_all(&inline, ", $1");
    rx!(r"(?i)[,.;!?\n]+|\b(?:and|but|then)\b").split(&separated).filter_map(|part| {
        let mut clause = part.trim();
        while !emphasis(clause) {
            let Some(prefix) = rx!(r"(?i)^(?:yeah|yes|ok(?:ay)?|actually|you know what|also|please|you can|(?:can|could|would) you|i (?:want|need|would like) you to|completely|just|instead)(?:\s+|$)").find(clause) else { break };
            clause = clause[prefix.end()..].trim_start();
        }
        (!clause.is_empty()).then(|| rx!(r"\x01(\d+)\x02").replace_all(clause, |c: &regex::Captures<'_>| {
            c[1].parse::<usize>().ok().and_then(|i| quotes.get(i)).cloned().unwrap_or_default()
        }).into_owned())
    }).collect()
}

pub(crate) fn explicit(text: &str) -> bool {
    let fragments = clauses(text);
    fragments
        .first()
        .and_then(|s| command(s))
        .is_some_and(|(delete, _)| {
            delete
                || fragments
                    .iter()
                    .skip(1)
                    .any(|s| command(s).is_some_and(|(delete, _)| delete))
        })
}

pub(crate) fn selected_pointer(text: &str) -> bool {
    rx!(r"(?i)^\s*(?:please\s+)?(?:delete|remove|erase)\s+(?:this|that|the selected)(?:\s+(?:task|event|item|session))?[.!\s]*$").is_match(text)
}

pub(crate) fn replacement(text: &str) -> bool {
    rx!(r"(?i)^\s*(?:please\s+)?instead[,\s]+(?:delete|remove|erase)\b").is_match(text)
}

pub(crate) fn date_token(text: &str, today: NaiveDate) -> Option<NaiveDate> {
    match text.to_ascii_lowercase().as_str() {
        "today" => Some(today),
        "tomorrow" => today.checked_add_days(Days::new(1)),
        "yesterday" => today.checked_sub_days(Days::new(1)),
        "end of this week" | "end of the week" => (0..7)
            .filter_map(|n| today.checked_add_days(Days::new(n)))
            .find(|d| d.format("%a").to_string() == "Sun"),
        other => date(other).ok().or_else(|| {
            let weekday = other
                .strip_prefix("next ")
                .or_else(|| other.strip_prefix("this "))
                .unwrap_or(other);
            let name = match weekday {
                "monday" => "Mon",
                "tuesday" => "Tue",
                "wednesday" => "Wed",
                "thursday" => "Thu",
                "friday" => "Fri",
                "saturday" => "Sat",
                "sunday" => "Sun",
                _ => return None,
            };
            let offset = u64::from(other.starts_with("next "));
            (offset..offset + 7)
                .filter_map(|n| today.checked_add_days(Days::new(n)))
                .find(|d| d.format("%a").to_string() == name)
        }),
    }
}

#[derive(Default)]
pub(crate) struct Plan {
    pub changes: Vec<Change>,
    pub companions: Vec<String>,
    pub explain: bool,
}

#[derive(Clone)]
struct Decision<'a> {
    target: &'a Target,
    remove: bool,
    order: usize,
}

#[derive(Clone)]
struct LinkDecision {
    remove: bool,
    order: usize,
    requires_task_deletion: bool,
}

#[derive(Clone)]
pub(crate) struct Confirmation {
    source: String,
    remove: bool,
    expected: String,
    candidates: Vec<Value>,
}

impl Confirmation {
    pub(crate) fn payload(&self, index: usize) -> Value {
        json!({"clause":index + 1,"source":self.source,"operation":if self.remove {"delete"} else {"keep"},"candidates":self.candidates})
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Match {
    clause: usize,
    source: String,
    target: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Matches {
    matches: Vec<Match>,
}

pub(crate) fn confirmed(content: &str, expected: &[Confirmation]) -> bool {
    serde_json::from_str::<Matches>(content).is_ok_and(|actual| {
        actual.matches.len() == expected.len()
            && expected.iter().enumerate().all(|(i, expected)| {
                actual.matches.iter().any(|m| {
                    m.clause == i + 1
                        && m.source == expected.source
                        && m.target == expected.expected
                })
            })
    })
}

fn anchors(text: &str) -> HashSet<String> {
    normalize(text).split_whitespace().filter_map(|word| {
        if word.chars().count() < 4 || "about been does from have need please should that their them then there these this those were where which will with would your task event calendar session".split_whitespace().any(|stop| stop == word) { return None; }
        let word = if word.chars().count() >= 5 {
            ["ing", "ed", "e", "s"].into_iter().find_map(|suffix| word.strip_suffix(suffix)).unwrap_or(word)
        } else { word };
        Some(word.into())
    }).collect()
}

fn shortlist<'a>(
    source: &str,
    description: &str,
    remove: bool,
    pool: &[&'a Target],
    out: &mut Vec<Confirmation>,
) -> Option<&'a Target> {
    if out.len() >= 5 || source.chars().count() > 240 ||
        rx!(r"(?i)\b(?:not|never|no|except|instead|unless|without|before|after|if|maybe|other|either|first|second|third|next|last|earliest|latest|all|every|both|only|today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|n['’]t\b|\b\d{4}-\d{2}-\d{2}\b").is_match(description) ||
        rx!(r"(?i)\b(?:wait|actually|rather than|keep|leave|spare|skip|forget|stop|cancel|avoid|exclude|omit|protect|preserve|delete|remove|erase|add|create)\b").is_match(description) {
        return None;
    }
    let evidence = anchors(description);
    let mut ranked = pool
        .iter()
        .filter_map(|item| {
            let shared = anchors(&item.title)
                .intersection(&evidence)
                .cloned()
                .collect::<HashSet<_>>();
            (!shared.is_empty()).then_some((*item, shared))
        })
        .collect::<Vec<_>>();
    ranked.sort_by_key(|(_, shared)| std::cmp::Reverse(shared.len()));
    let (target, shared) = ranked.first()?;
    if shared.len() < 2
        || ranked
            .iter()
            .skip(1)
            .any(|(_, other)| other.len() == shared.len() || !other.is_subset(shared))
    {
        return None;
    }
    out.push(Confirmation {
        source: source.into(), remove, expected: target.key(),
        candidates: ranked.iter().take(5).map(|(item, _)| json!({"key":item.key(),"title":item.title.chars().take(240).collect::<String>()})).collect(),
    });
    Some(*target)
}

pub(crate) struct Context<'a> {
    pub snapshot: &'a Value,
    pub items: &'a [Target],
    pub today: NaiveDate,
    pub selected: Option<&'a Target>,
    pub references: &'a [Target],
    pub selection_unavailable: bool,
}

struct Resolver<'a, 'c> {
    context: &'c Context<'a>,
    remove: bool,
    nearby: &'c [&'a Target],
    external: &'c [&'a Target],
}

impl<'a> Resolver<'a, '_> {
    fn choose(
        &self,
        matches: Vec<&'a Target>,
        many: bool,
        phrase: &str,
    ) -> Result<Vec<&'a Target>> {
        if many || matches.len() <= 1 {
            return Ok(matches);
        }
        if let Some(selected) = self.context.selected
            && matches.contains(&selected)
        {
            return Ok(vec![selected]);
        }
        bail!("I found several planner items matching “{phrase}”. Which one do you mean?")
    }

    fn resolve(
        &self,
        phrase: &str,
        forced: Option<Entity>,
        mut descriptions: Option<&mut Vec<Confirmation>>,
    ) -> Result<Vec<&'a Target>> {
        let clean = rx!(r"(?i)\s+only$").replace(phrase.trim(), "");
        let clean = rx!(r"(?i)^(?:only|just)\s+").replace(&clean, "");
        let direct = |value: &str, scope: Option<Entity>| {
            self.context
                .items
                .iter()
                .filter(|item| {
                    scope.map_or_else(|| planner(item), |entity| item.entity == entity)
                        && (item.id == unquote(value)
                            || normalize(&item.title) == normalize(unquote(value)))
                })
                .collect::<Vec<_>>()
        };
        let trailing_kind = rx!(
            r"(?i)(?:^|\s+)(tasks?|(?:calendar )?(?:events?|sessions?)|projects?|sections?|categor(?:y|ies))$"
        );
        let whole = direct(&clean, forced)
            .into_iter()
            .filter(|item| {
                item.id == unquote(&clean)
                    || clean != unquote(&clean)
                    || !trailing_kind.is_match(&clean)
            })
            .collect::<Vec<_>>();
        if !whole.is_empty() {
            return self.choose(whole, false, phrase);
        }

        let day = rx!(r"(?i)\s+(?:(?:for|on)\s+)?(today|tomorrow|yesterday|\d{4}-\d{2}-\d{2})$")
            .captures(&clean);
        let date = day
            .as_ref()
            .map(|m| {
                date_token(&m[1], self.context.today)
                    .ok_or_else(|| anyhow!("Which date did you mean for “{phrase}”?"))
            })
            .transpose()?
            .map(|d| d.to_string());
        let base = day
            .as_ref()
            .map_or(clean.as_ref(), |m| &clean[..m.get(0).unwrap().start()]);
        let subject = rx!(r"(?i)^(?:the|my|a|an)\s+").replace(base, "");
        let bulk = rx!(r"(?i)^(?:all|every|both)\s+").find(&subject);
        let subject = bulk.map_or(subject.as_ref(), |m| &subject[m.end()..]);
        let standalone = rx!(r"(?i)^standalone\s+").find(subject);
        let subject = standalone.map_or(subject, |m| &subject[m.end()..]);
        let trailing = trailing_kind.captures(subject);
        let leading = rx!(r"(?i)^(tasks?|(?:calendar )?(?:events?|sessions?)|projects?|sections?|categor(?:y|ies))(?:\s+(?:(named|called|titled)\s+)?|$)").captures(subject);
        let named = leading.as_ref().is_some_and(|m| m.get(2).is_some());
        let use_trailing = !named && trailing.is_some();
        let typed = if use_trailing {
            trailing.as_ref()
        } else {
            leading.as_ref()
        };
        let scope = typed.and_then(|m| kind(&m[1])).or(if standalone.is_some() {
            Some(Entity::Event)
        } else {
            forced
        });
        if forced.is_some() && forced != scope
            || standalone.is_some() && scope != Some(Entity::Event)
        {
            return Ok(Vec::new());
        }
        let exactly_two = bulk.is_some_and(|m| m.as_str().trim().eq_ignore_ascii_case("both"));
        let plural = typed.is_some_and(|m| {
            let noun = m[1].to_ascii_lowercase();
            noun.ends_with('s') || noun.ends_with("ies")
        });
        let many = bulk.is_some() && !exactly_two || plural;
        let name = typed.map_or(subject, |m| {
            if use_trailing {
                &subject[..m.get(0).unwrap().start()]
            } else {
                &subject[m.get(0).unwrap().end()..]
            }
        });
        let name = rx!(r"(?i)\s+(?:one|ones)$").replace(name.trim(), "");
        let snapshot = self.context.snapshot;
        let events = snapshot["events"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default();
        let pool = self
            .context
            .items
            .iter()
            .filter(|item| {
                scope.map_or_else(|| planner(item), |entity| item.entity == entity)
                    && (standalone.is_none()
                        || record(snapshot, Entity::Event, &item.id)
                            .is_some_and(|event| event["linkedTaskId"].is_null()))
                    && date.as_deref().is_none_or(|day| {
                        let spans = |event: &Value| {
                            event["startDate"]
                                .as_str()
                                .is_some_and(|start| start <= day)
                                && event["endDate"].as_str().is_some_and(|end| end >= day)
                        };
                        match item.entity {
                            Entity::Event => {
                                record(snapshot, Entity::Event, &item.id).is_some_and(spans)
                            }
                            Entity::Task => {
                                record(snapshot, Entity::Task, &item.id)
                                    .is_some_and(|task| task["dueDate"] == day)
                                    || events.iter().any(|event| {
                                        event["linkedTaskId"] == item.id
                                            && event["kind"] == "planned"
                                            && spans(event)
                                    })
                            }
                            _ => false,
                        }
                    })
            })
            .collect::<Vec<_>>();
        let both = !self.remove && name.eq_ignore_ascii_case("both");
        if name.is_empty() || pointer(&name) || both {
            let refs = if !self.nearby.is_empty() && !rx!(r"(?i)\bselected\b").is_match(&name) {
                self.nearby
            } else {
                self.external
            };
            let all = (name.is_empty() && bulk.is_some() && scope.is_some())
                || (!self.context.selection_unavailable
                    && refs.is_empty()
                    && date.is_some()
                    && scope.is_some());
            let candidates = if all {
                pool
            } else {
                pool.into_iter()
                    .filter(|item| {
                        refs.contains(item)
                            || !self.remove
                                && scope == Some(Entity::Task)
                                && events.iter().any(|event| {
                                    event["linkedTaskId"] == item.id
                                        && refs.iter().any(|target| {
                                            target.entity == Entity::Event
                                                && event["id"] == target.id
                                        })
                                })
                    })
                    .collect()
            };
            ensure!(
                !candidates.is_empty(),
                "Which planner item do you mean? Give me its exact name or select its card."
            );
            ensure!(
                !exactly_two || candidates.len() == 2,
                "Which two planner items do you mean?"
            );
            return self.choose(candidates, many || both || exactly_two, phrase);
        }
        let phrase_alias = alias(unquote(&name));
        let leading_title = forced.is_none()
            && leading.is_some()
            && trailing.is_none()
            && bulk.is_none()
            && date.is_none()
            && standalone.is_none();
        let select = |mut matches: Vec<&'a Target>| {
            if leading_title {
                for item in self
                    .context
                    .items
                    .iter()
                    .filter(|item| planner(item) && alias(&item.title) == alias(subject))
                {
                    if !matches.contains(&item) {
                        matches.push(item);
                    }
                }
            }
            ensure!(
                !exactly_two || !plural || matches.is_empty() || matches.len() == 2,
                "Which two planner items matching “{phrase}” do you mean?"
            );
            self.choose(matches, many, phrase)
        };
        let mut exact = direct(&name, scope);
        if typed.is_some() {
            for item in direct(subject, scope) {
                if !exact.contains(&item) {
                    exact.push(item);
                }
            }
        }
        exact.retain(|item| pool.contains(item));
        if !exact.is_empty() {
            return select(exact);
        }
        let matches = select(
            pool.iter()
                .copied()
                .filter(|item| !phrase_alias.is_empty() && alias(&item.title) == phrase_alias)
                .collect(),
        )?;
        if !matches.is_empty() {
            return Ok(matches);
        }
        if name == unquote(&name) {
            let dictated = pool
                .iter()
                .copied()
                .filter(|item| dictation_matches(&name, &item.title))
                .collect::<Vec<_>>();
            if !dictated.is_empty() {
                return self.choose(dictated, false, phrase);
            }
        }
        if typed.is_some_and(|m| rx!(r"(?i)\bsessions?$").is_match(&m[1])) && standalone.is_none() {
            let tasks = self.choose(
                self.context
                    .items
                    .iter()
                    .filter(|item| {
                        item.entity == Entity::Task
                            && !phrase_alias.is_empty()
                            && alias(&item.title) == phrase_alias
                    })
                    .collect(),
                false,
                phrase,
            )?;
            if let Some(task) = tasks.first() {
                let matches = pool
                    .iter()
                    .copied()
                    .filter(|item| {
                        events
                            .iter()
                            .any(|event| event["id"] == item.id && event["linkedTaskId"] == task.id)
                    })
                    .collect();
                let matches: Vec<_> = matches;
                ensure!(
                    !exactly_two || !plural || matches.len() == 2,
                    "Which two planner items matching “{phrase}” do you mean?"
                );
                return self.choose(matches, many, phrase);
            }
        }
        if !use_trailing
            && leading.is_some()
            && !many
            && date.is_none()
            && standalone.is_none()
            && matches!(scope, Some(Entity::Task | Entity::Event))
            && !name.contains(['"', '“'])
            && let Some(description) = rx!(r"(?i)^(?:about|for|where)\s+(.+)$").captures(&name)
            && let Some(out) = descriptions.as_mut()
            && let Some(item) = shortlist(phrase, &description[1], self.remove, &pool, out)
        {
            return Ok(vec![item]);
        }
        Ok(Vec::new())
    }
}

pub(crate) fn plan(
    text: &str,
    context: &Context<'_>,
    mut descriptions: Option<&mut Vec<Confirmation>>,
) -> Result<Plan> {
    let fragments = clauses(text);
    let mut decisions = Vec::<Decision<'_>>::new();
    let mut linked = HashMap::<&str, LinkDecision>::new();
    let mut result = Plan::default();
    let mut operation = None;
    let mut awaiting = false;
    let mut group = Vec::<&Target>::new();
    let mut prior_group = Vec::new();
    let mut group_links = HashSet::<&str>::new();
    let mut group_named = true;
    let external = context
        .selected
        .map(|selected| vec![selected])
        .unwrap_or_else(|| {
            if context.selection_unavailable {
                Vec::new()
            } else {
                context
                    .items
                    .iter()
                    .filter(|item| planner(item) && context.references.contains(item))
                    .collect()
            }
        });
    let require_target = |awaiting: bool, operation| {
        ensure!(
            !awaiting,
            "Which planner item did you mean to {}?",
            if operation == Some(false) {
                "keep"
            } else {
                "delete"
            }
        );
        Ok(())
    };
    for (order, raw) in fragments.iter().enumerate() {
        if rx!(r"(?i)^or\b").is_match(raw) && operation != Some(false) {
            bail!("Which deletion target did you mean instead of “{raw}”?");
        }
        if emphasis(raw) && operation == Some(true) && !awaiting {
            continue;
        }
        let fragment = rx!(r"(?i)^or\s+").replace(raw, "");
        let fragment = rx!(r"(?i)\s+as well$").replace(&fragment, "");
        let repeated = rx!(r"(?i)^do the same (?:with|for|to)\s+").find(&fragment);
        let repeated_kind = repeated
            .and_then(|_| group.first())
            .map(|item| item.entity)
            .filter(|entity| group.iter().all(|item| item.entity == *entity));
        let repeat_links = repeated.is_some() && !group_links.is_empty();
        if repeated.is_some() {
            require_target(awaiting, operation)?;
            ensure!(
                operation == Some(true)
                    && !group.is_empty()
                    && (!repeat_links
                        || group_links.len() == group.len()
                            && group.iter().all(|item| item.entity == Entity::Task
                                && group_links.contains(item.id.as_str()))),
                "Which items and linked calendar events should I remove?"
            );
            prior_group = std::mem::take(&mut group);
            group_links.clear();
            group_named = true;
            awaiting = true;
        }
        let action = command(&fragment);
        if let Some((remove, _)) = action {
            require_target(awaiting, operation)?;
            operation = Some(remove);
            if !group.is_empty() {
                prior_group = std::mem::take(&mut group);
            }
            group_links.clear();
            group_named = true;
            awaiting = true;
        }
        let subject = fragment[action
            .map(|(_, end)| end)
            .or_else(|| repeated.map(|m| m.end()))
            .unwrap_or(0)..]
            .trim();
        let phrase = if operation == Some(false) {
            rx!(r"(?i)\s+(?:as an? (?:independent|standalone) event|unchanged)$")
                .replace(subject, "")
        } else {
            subject.into()
        };
        if phrase.is_empty() || rx!(r"(?i)^(?:the|a|an)$").is_match(&phrase) {
            continue;
        }
        ensure!(
            !repeat_links || !rx!(r"(?i)(?:^only\s+|\s+only$)").is_match(&phrase),
            "Should I remove the task and its linked calendar events, or the task only?"
        );
        if action.is_none() && repeated.is_none() {
            if rx!(r"(?i)^(?:why|how|what|when|where|who|explain|walk me through|tell me|help me understand)\b").is_match(&phrase) {
                require_target(awaiting, operation)?;
                operation = None;
                result.explain = true;
                continue;
            }
            if rx!(r"(?i)^(?:add|create|schedule|remind|put|make|record|submit|i (?:need|have|want) to|move|reschedule|update|change|rename|recolor|categorize|organize|mark|complete|reopen|set|tick|uncheck|check off|restore|undo|bring)\b").is_match(&phrase) {
                require_target(awaiting, operation)?;
                result.companions.push(phrase.into_owned());
                operation = None;
                continue;
            }
        }
        let remove =
            operation.ok_or_else(|| anyhow!("Which planner change did you mean by “{phrase}”?"))?;
        let nearby = if group.is_empty() {
            &prior_group
        } else {
            &group
        };
        let resolver = Resolver {
            context,
            remove,
            nearby,
            external: &external,
        };
        if repeated.is_none()
            && let Some(c) = association(&phrase)
        {
            let reference = c.get(3).map(|m| m.as_str());
            let tasks = if reference.is_some_and(each_task) {
                ensure!(
                    group_named
                        && !group.is_empty()
                        && group.iter().all(|target| target.entity == Entity::Task),
                    "Which named tasks should I include when removing calendar sessions?"
                );
                group.clone()
            } else if let Some(reference) = reference.filter(|s| !pointer(s)) {
                resolver.resolve(reference, Some(Entity::Task), descriptions.as_deref_mut())?
            } else if !nearby.is_empty() {
                nearby.clone()
            } else {
                external.clone()
            };
            let tasks = tasks
                .into_iter()
                .filter(|item| item.entity == Entity::Task)
                .collect::<Vec<_>>();
            ensure!(
                !tasks.is_empty(),
                "Which task are those calendar events associated with?"
            );
            for task in tasks {
                linked.insert(
                    &task.id,
                    LinkDecision {
                        remove,
                        order,
                        requires_task_deletion: nearby.contains(&task)
                            && decisions.iter().any(|d| d.target == task && d.remove),
                    },
                );
                group_links.insert(&task.id);
            }
            awaiting = false;
            continue;
        }
        let later = &fragments[order + 1..];
        let task_scope = later
            .iter()
            .take_while(|part| command(part).is_none())
            .any(|part| {
                association(part)
                    .and_then(|c| c.get(3))
                    .is_some_and(|reference| each_task(reference.as_str()))
            });
        let coordinated_both = later
            .first()
            .is_some_and(|part| command(part).is_none() && named_clause(part));
        let qualified = if coordinated_both {
            rx!(r"(?i)^(?:the\s+)?both\s+").replace(&phrase, "")
        } else {
            std::borrow::Cow::Borrowed(phrase.as_ref())
        };
        let found = resolver.resolve(
            &qualified,
            repeated_kind.or(task_scope.then_some(Entity::Task)),
            descriptions.as_deref_mut(),
        )?;
        ensure!(
            !found.is_empty(),
            "I could not find a planner item matching “{phrase}”. Which item do you mean?"
        );
        group_named &= named_clause(&qualified);
        awaiting = false;
        for target in &found {
            if !remove
                && target.entity == Entity::Task
                && linked
                    .get(target.id.as_str())
                    .is_some_and(|d| d.requires_task_deletion)
            {
                linked.remove(target.id.as_str());
            }
            upsert(
                &mut decisions,
                Decision {
                    target,
                    remove,
                    order,
                },
            );
            if repeat_links && target.entity == Entity::Task {
                linked.insert(
                    &target.id,
                    LinkDecision {
                        remove: true,
                        order,
                        requires_task_deletion: true,
                    },
                );
                group_links.insert(&target.id);
            }
        }
        group.extend(found);
    }
    require_target(awaiting, operation)?;
    for event in context
        .items
        .iter()
        .filter(|item| item.entity == Entity::Event)
    {
        let Some(task_id) = record(context.snapshot, Entity::Event, &event.id)
            .and_then(|row| row["linkedTaskId"].as_str())
        else {
            continue;
        };
        let Some(decision) = linked.get(task_id) else {
            continue;
        };
        if decision.requires_task_deletion
            && decision.remove
            && !decisions
                .iter()
                .any(|d| d.remove && d.target.entity == Entity::Task && d.target.id == task_id)
        {
            continue;
        }
        if decisions
            .iter()
            .all(|d| d.target != event || d.order < decision.order)
        {
            upsert(
                &mut decisions,
                Decision {
                    target: event,
                    remove: decision.remove,
                    order: decision.order,
                },
            );
        }
    }
    result.changes = decisions
        .into_iter()
        .filter(|d| d.remove)
        .map(|d| Change::new(Action::Delete, d.target.entity, d.target.id.clone(), None))
        .collect();
    Ok(result)
}

fn upsert<'a>(decisions: &mut Vec<Decision<'a>>, decision: Decision<'a>) {
    if let Some(old) = decisions
        .iter_mut()
        .find(|old| old.target == decision.target)
    {
        *old = decision;
    } else {
        decisions.push(decision);
    }
}
