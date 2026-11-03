use rcv_tally::{fptp::run_fptp, irv::run_irv, sequential_irv::run_sequential_irv, stv::run_stv};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use wasm_bindgen::prelude::*;

fn counts(c: &BTreeMap<u32, u64>) -> Value {
    let mut m = Map::new();
    for (k, v) in c {
        m.insert(k.to_string(), json!(v));
    }
    Value::Object(m)
}

/// Tally  (an array of rankings) exactly as the template\x27s  does.
/// : "irv" | "fptp" | "sequential-irv" | "stv". Returns the VoteResult as JSON.
#[wasm_bindgen]
pub fn tally(method: &str, ballots_json: &str, num_candidates: u32, num_winners: u32) -> Result<String, JsError> {
    let ballots: Vec<Vec<u32>> = serde_json::from_str(ballots_json).map_err(|e| JsError::new(&e.to_string()))?;
    let v = match method {
        "irv" => {
            let (winner, rounds) = run_irv(&ballots, num_candidates);
            json!({ "Irv": { "winner": winner, "rounds": rounds.iter().map(|r| json!({ "counts": counts(&r.counts), "eliminated": r.eliminated })).collect::<Vec<_>>() } })
        }
        "fptp" => {
            let (winner, c) = run_fptp(&ballots, num_candidates);
            json!({ "Fptp": { "winner": winner, "counts": counts(&c) } })
        }
        "sequential-irv" => {
            let (winners, seats) = run_sequential_irv(&ballots, num_candidates, num_winners);
            json!({ "SequentialIrv": { "winners": winners, "seats": seats.iter().map(|s| json!({ "winner": s.winner, "irv_rounds": s.irv_rounds.iter().map(|r| json!({ "counts": counts(&r.counts), "eliminated": r.eliminated })).collect::<Vec<_>>() })).collect::<Vec<_>>() } })
        }
        "stv" => {
            let (winners, rounds) = run_stv(&ballots, num_candidates, num_winners);
            json!({ "Stv": { "winners": winners, "rounds": rounds.iter().map(|r| json!({ "counts": counts(&r.counts), "elected": r.elected, "eliminated": r.eliminated, "quota": r.quota })).collect::<Vec<_>>() } })
        }
        other => return Err(JsError::new(&format!("unknown method {other}"))),
    };
    Ok(v.to_string())
}
