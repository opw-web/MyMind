use anyhow::{Result, anyhow};
use chrono::{Datelike, Days, NaiveDate};

pub(crate) fn date(value: &str) -> Result<NaiveDate> {
    if value.len() == 10
        && let Ok(date) = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        && date.format("%Y-%m-%d").to_string() == value
    {
        return Ok(date);
    }
    Err(anyhow!("Use a valid date in YYYY-MM-DD format"))
}

pub(crate) fn time(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 5
        && bytes[2] == b':'
        && [0, 1, 3, 4]
            .iter()
            .all(|&index| bytes[index].is_ascii_digit())
        && [bytes[0], bytes[1]] <= *b"23"
        && [bytes[3], bytes[4]] <= *b"59"
}

pub(crate) fn shift_end(old_start: &str, old_end: &str, new_start: &str) -> Result<String> {
    let span = (date(old_end)? - date(old_start)?).num_days();
    let new_start = date(new_start)?;
    let end = if span >= 0 {
        new_start.checked_add_days(Days::new(span as u64))
    } else {
        new_start.checked_sub_days(Days::new(span.unsigned_abs()))
    };
    let end = end.ok_or_else(|| anyhow!("The event date is out of range."))?;
    Ok(end.format("%Y-%m-%d").to_string())
}

pub(crate) fn readable_date(value: &str) -> Result<String> {
    let date = date(value)?;
    // Intl en-IN abbreviates September to "Sept".
    let format = if date.month() == 9 {
        "%-d Sept %Y"
    } else {
        "%-d %b %Y"
    };
    Ok(date.format(format).to_string())
}
