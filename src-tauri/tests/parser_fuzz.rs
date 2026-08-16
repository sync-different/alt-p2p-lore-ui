// Adversarial input across every hand-rolled parser. None may panic; all must return a
// value (None / empty / a struct), never crash the thread that reads a subprocess's output.
use alt_p2p_lore_ui_lib::lore::{parse, auth};

const NASTY: &[&str] = &[
    "", " ", "\n", "\t\r", "é", "🎨", "→", "\u{1b}[2J\u{1b}[K",
    "Auth URL: é", "User: é(", "User: (é)", "Expires: é, é é é é:é:é +éé",
    "On branch é revision é -> é", "Repository", "M ", " M", "M",
    "Local branch é diverged", "Remote branch does not exist é",
    "Changes not staged for commit:", "\0\0\0", "A\0B",
    "Expires: Fri, 99 Zzz 999999999999999999 99:99:99 +9999",
    "Expires: , , ,  :: ", "Domains: ,,,,,",
    "Expires: Fri, 14 Aug 999999999999999999 05:11:52 +0000",
];

#[test]
fn no_parser_panics_on_hostile_input() {
    for s in NASTY {
        let _ = parse::parse_status(s);
        let _ = parse::parse_diff(s);
        let _ = parse::parse_locks(s);
        let _ = auth::parse_auth_list(s);
        let _ = auth::parse_rfc2822_ms(s);
        // Multi-line combinations, since parsers carry state across lines.
        let doc = format!("Auth URL: {s}\nUser: {s}\nExpires: {s}\nDomains: {s}");
        let _ = auth::parse_auth_list(&doc);
        let doc2 = format!("Repository {s}\nOn branch {s}\n{s}\nM {s}");
        let _ = parse::parse_status(&doc2);
    }
    // Every byte value 0..255 as a single-char line through each parser.
    for b in 0u8..=255 {
        let line = (b as char).to_string();
        let _ = parse::parse_status(&line);
        let _ = auth::parse_rfc2822_ms(&line);
    }
    println!("PARSER FUZZ OK");
}
