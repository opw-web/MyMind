use anyhow::{Result, anyhow, ensure};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

fn prerequisites(task: &Value) -> &[Value] {
    task["dependsOnIds"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
}

pub(crate) fn validate_graph(tasks: &[Value]) -> Result<()> {
    let by_id = tasks
        .iter()
        .filter_map(|task| task["id"].as_str().map(|id| (id, task)))
        .collect::<HashMap<_, _>>();
    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();

    // A valid chain may span an entire batch. Keep traversal off the thread stack.
    for task in tasks {
        let root = task["id"]
            .as_str()
            .ok_or_else(|| anyhow!("Invalid saved task ID."))?;
        if visited.contains(root) {
            continue;
        }
        visiting.insert(root);
        let mut stack = vec![(root, prerequisites(task).iter())];
        while let Some((id, remaining)) = stack.last_mut() {
            let id = *id;
            if let Some(dependency) = remaining.next() {
                let dependency = dependency
                    .as_str()
                    .ok_or_else(|| anyhow!("Invalid prerequisite task."))?;
                ensure!(dependency != id, "A task cannot depend on itself.");
                if visited.contains(dependency) {
                    continue;
                }
                ensure!(
                    visiting.insert(dependency),
                    "Task prerequisites cannot contain a cycle."
                );
                let task = by_id.get(dependency).ok_or_else(|| {
                    anyhow!("A prerequisite task no longer exists. Refresh and try again.")
                })?;
                stack.push((dependency, prerequisites(task).iter()));
            } else {
                stack.pop();
                visiting.remove(id);
                visited.insert(id);
            }
        }
    }
    Ok(())
}
