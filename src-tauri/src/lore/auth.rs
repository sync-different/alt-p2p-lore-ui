//! Reading `lore auth list`, and saying something useful about expiry *before* it bites.
//!
//! Identity tokens last 12 hours. Expiring mid-work cost three interruptions in two days,
//! each needing physical access to a locked box — so the warning is the feature here, not
//! the display. The app cannot mint a token; it can make sure nobody is surprised by one
//! running out.
//!
//! There is no machine-readable form of this command, so the plain output is parsed against
//! golden fixtures captured from the real CLI. The shape:
//!
//! ```text
//! Auth URL: https://127.0.0.1:9443
//!   Resource: 019f9e9f8f157e12a7ab77330299cfd4    (only on resource-scoped tokens)
//!   User: ale (u-87c4b8c8b7f44fc1)
//!   Domains: https://lore-identity.example/, https://127.0.0.1:9443/
//!   Expires: Fri, 14 Aug 2026 05:11:52 +0000
//! ```
//!
//! Nothing stored at all prints nothing and exits 0 — so empty output means "not signed
//! in", not "something went wrong".

use super::cmd;
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// One stored identity, as `lore auth list` describes it.
#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct AuthIdentity {
    pub auth_url: String,
    /// Present only on resource-scoped (authorization) tokens.
    pub resource: Option<String>,
    pub user: Option<String>,
    pub user_id: Option<String>,
    pub domains: Vec<String>,
    /// Exactly as printed, so the UI can show what the CLI would.
    pub expires_raw: Option<String>,
    /// Parsed to epoch milliseconds. `None` when the date could not be read — which is
    /// deliberately *not* the same as "expired", see `Expiry`.
    pub expires_ms: Option<i64>,
}

impl AuthIdentity {
    /// The loopback port in the auth URL, which is how a session is matched to its identity:
    /// the tunnel forwards the host's identity service to `127.0.0.1:<identity_port>`, and
    /// the CLI files tokens under that exact URL.
    pub fn loopback_port(&self) -> Option<u16> {
        let rest = self.auth_url.rsplit_once(':')?.1;
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        digits.parse().ok()
    }
}

/// What to tell the user about a token's remaining life.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case", tag = "state", content = "minutes")]
pub enum Expiry {
    /// No token at all for this host.
    Missing,
    /// Comfortably valid; the number is minutes remaining.
    Valid(i64),
    /// Valid, but not for much longer.
    Soon(i64),
    /// Already past. The number is how many minutes ago.
    Expired(i64),
    /// A date we could not read. Never reported as valid: a green light we cannot justify
    /// is worse than an honest "unknown", because it is the one that lets work start.
    Unknown,
}

/// How long before expiry counts as "soon".
///
/// An hour is enough to finish and push what is open, which is the point — a five-minute
/// warning arrives when the damage is already unavoidable.
pub const WARN_WITHIN_MINUTES: i64 = 60;

pub fn classify(identity: Option<&AuthIdentity>, now_ms: i64) -> Expiry {
    let Some(id) = identity else { return Expiry::Missing };
    let Some(exp) = id.expires_ms else { return Expiry::Unknown };
    let minutes = (exp - now_ms) / 60_000;
    if minutes < 0 {
        Expiry::Expired(-minutes)
    } else if minutes <= WARN_WITHIN_MINUTES {
        Expiry::Soon(minutes)
    } else {
        Expiry::Valid(minutes)
    }
}

/// Parse the whole of `lore auth list`.
pub fn parse_auth_list(text: &str) -> Vec<AuthIdentity> {
    let mut out: Vec<AuthIdentity> = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        if let Some(url) = t.strip_prefix("Auth URL:") {
            out.push(AuthIdentity { auth_url: url.trim().to_string(), ..Default::default() });
            continue;
        }
        // Every other field belongs to the entry opened by the last Auth URL. A field before
        // any header is ignored rather than guessed at.
        let Some(cur) = out.last_mut() else { continue };
        if let Some(v) = t.strip_prefix("Resource:") {
            cur.resource = Some(v.trim().to_string());
        } else if let Some(v) = t.strip_prefix("User:") {
            let (name, id) = split_user(v.trim());
            cur.user = name;
            cur.user_id = id;
        } else if let Some(v) = t.strip_prefix("Domains:") {
            let mut seen: Vec<String> = Vec::new();
            for d in v.split(',').map(str::trim).filter(|d| !d.is_empty()) {
                // The CLI repeats domains — the real capture lists `https://127.0.0.1:9443/`
                // twice. Showing the same host twice reads as a configuration mistake.
                if !seen.iter().any(|s| s == d) {
                    seen.push(d.to_string());
                }
            }
            cur.domains = seen;
        } else if let Some(v) = t.strip_prefix("Expires:") {
            let raw = v.trim().to_string();
            cur.expires_ms = parse_rfc2822_ms(&raw);
            cur.expires_raw = Some(raw);
        }
    }
    out
}

/// Every identity filed under a session's forwarded identity port.
///
/// **More than one is normal.** `lore` stores `[[remotes.token]]` as an array, so signing in
/// as a second user adds an identity rather than replacing the first — two people's tokens
/// live under one auth URL at once. An earlier version of this returned a single identity
/// and picked whichever came first, which reported the wrong user after a sign-in that had
/// in fact succeeded.
///
/// Only unscoped (authentication) tokens are returned. A resource token is derived from one
/// of these without a sign-in, so its expiry stops one repository rather than the session.
pub fn for_identity_port(list: &[AuthIdentity], port: u16) -> Vec<&AuthIdentity> {
    list.iter()
        .filter(|i| i.loopback_port() == Some(port) && i.resource.is_none())
        .collect()
}

/// Expiry for a set of identities, taking the **soonest**.
///
/// Which identity `lore` uses for a given operation is its decision, not ours. With more
/// than one stored we cannot say which will be picked, so the honest reading is the one that
/// runs out first — anything else would show green while the identity actually in use had
/// already expired.
pub fn classify_all(identities: &[&AuthIdentity], now_ms: i64) -> Expiry {
    if identities.is_empty() {
        return Expiry::Missing;
    }
    // Unknown wins over any number: an expiry we could not read cannot be ordered against
    // one we could, and treating it as absent would let a readable sibling vouch for it.
    if identities.iter().any(|i| i.expires_ms.is_none()) {
        return Expiry::Unknown;
    }
    identities
        .iter()
        .map(|i| classify(Some(i), now_ms))
        .min_by_key(|e| match e {
            Expiry::Expired(m) => -*m,
            Expiry::Soon(m) | Expiry::Valid(m) => *m,
            _ => i64::MAX,
        })
        .unwrap_or(Expiry::Unknown)
}

fn split_user(s: &str) -> (Option<String>, Option<String>) {
    match (s.find('('), s.rfind(')')) {
        (Some(a), Some(b)) if b > a => {
            let name = s[..a].trim();
            let id = s[a + 1..b].trim();
            (
                (!name.is_empty()).then(|| name.to_string()),
                (!id.is_empty()).then(|| id.to_string()),
            )
        }
        _ => ((!s.is_empty()).then(|| s.to_string()), None),
    }
}

// --- dates -----------------------------------------------------------------
// `Fri, 14 Aug 2026 05:11:52 +0000`. Hand-parsed rather than pulling in a date library for
// one format: the input comes from one program, in one shape, and a wrong answer here is
// caught by the fixtures. Anything unexpected returns None, which the UI shows as "unknown"
// rather than inventing a deadline.

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

pub fn parse_rfc2822_ms(s: &str) -> Option<i64> {
    // Drop the optional day-of-week; it carries no information we need and would only be
    // another thing to get wrong.
    let s = s.split_once(',').map(|(_, r)| r).unwrap_or(s).trim();
    let mut parts = s.split_whitespace();
    let day: i64 = parts.next()?.parse().ok()?;
    let month_name = parts.next()?;
    let month = MONTHS.iter().position(|m| *m == month_name)? as i64 + 1;
    let year: i64 = parts.next()?.parse().ok()?;

    let mut hms = parts.next()?.split(':');
    let hour: i64 = hms.next()?.parse().ok()?;
    let min: i64 = hms.next()?.parse().ok()?;
    let sec: i64 = hms.next().unwrap_or("0").parse().ok()?;

    // An absent zone means UTC here: the CLI always prints one, and guessing local time
    // would silently shift every deadline by the machine's offset.
    let offset_minutes = parts.next().map(parse_offset).unwrap_or(Some(0))?;

    let days = days_from_civil(year, month, day);
    Some(((days * 86_400 + hour * 3600 + min * 60 + sec) - offset_minutes * 60) * 1000)
}

fn parse_offset(z: &str) -> Option<i64> {
    if z.eq_ignore_ascii_case("GMT") || z.eq_ignore_ascii_case("UTC") || z == "Z" {
        return Some(0);
    }
    let sign = match z.chars().next()? {
        '+' => 1,
        '-' => -1,
        _ => return None,
    };
    let digits = &z[1..];
    if digits.len() != 4 || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let h: i64 = digits[..2].parse().ok()?;
    let m: i64 = digits[2..].parse().ok()?;
    Some(sign * (h * 60 + m))
}

/// Days since 1970-01-01, by Howard Hinnant's civil-date algorithm. Leap years included,
/// no lookup tables, valid well past any token lifetime.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

// --- recognising an auth failure in someone else's error --------------------

/// Does this failure mean "your access has expired" rather than anything else?
///
/// Worth having because lore reports it as a storage or transport error, several layers from
/// the cause. Relaying that verbatim sends people to look at the network, the tunnel, or the
/// repository — every place except the one that is actually wrong.
pub fn looks_like_auth_failure(text: &str) -> bool {
    let t = text.to_lowercase();
    const SIGNS: &[&str] = &[
        "unauthenticated",
        "unauthorized",
        "unauthorised",
        "token expired",
        "token has expired",
        "expired token",
        "authentication required",
        "requires a configured auth endpoint",
        "not authenticated",
        "permission denied",
        "401",
        "403",
    ];
    SIGNS.iter().any(|s| t.contains(s))
}

/// The sentence to show for an auth failure. The raw error is kept by the caller and shown
/// under Details — replaced, not discarded.
pub fn auth_failure_message() -> &'static str {
    "Your access to this host has expired. Sign in again to continue."
}

// --- commands ---------------------------------------------------------------

/// Everything the UI needs to talk about one session's sign-in.
#[derive(serde::Serialize, Clone, Debug)]
pub struct AuthStatus {
    /// Every identity filed under this session's auth URL. More than one is normal — see
    /// `for_identity_port`.
    pub identities: Vec<AuthIdentity>,
    /// The soonest expiry among them.
    pub expiry: Expiry,
    /// Everything in the store, including resource-scoped tokens, for diagnosis.
    pub all: Vec<AuthIdentity>,
}

/// `lore auth list` is not repository-scoped, so it needs a directory only because every
/// process needs one. Home is somewhere that certainly exists and that we do not write to.
fn neutral_cwd(app: &AppHandle) -> PathBuf {
    app.path()
        .home_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
}

/// Sign-in state for a host, optionally narrowed to one identity.
///
/// `identity` is what the workspace in front of the user is pinned to. When a workspace has
/// chosen, "how long have I got?" is about *that* identity — not about whichever of the
/// stored ones expires first. Reporting the set while the work was pinned showed a countdown
/// belonging to someone else entirely.
#[tauri::command]
pub async fn auth_status(
    app: AppHandle,
    identity_port: Option<u16>,
    identity: Option<String>,
    now_ms: i64,
) -> Result<AuthStatus, String> {
    let cwd = neutral_cwd(&app);
    let out = cmd::run(&app, &cwd, vec!["auth".into(), "list".into()], None)
        .await
        .map_err(|e| e.to_string())?;

    let all = parse_auth_list(&out.stdout);
    // A session with no identity port needs no sign-in at all — reporting Missing there
    // would put a warning on a host that never asked for one.
    let identities: Vec<AuthIdentity> = identity_port
        .map(|p| for_identity_port(&all, p).into_iter().cloned().collect())
        .unwrap_or_default();
    let expiry = match (identity_port, identity.as_deref()) {
        // Pinned: one identity's clock, and Missing when it is not signed in at all — which
        // is the state that makes every call fail with "No token stored".
        (Some(p), Some(id)) => classify(
            for_identity_port(&all, p).into_iter().find(|i| i.user_id.as_deref() == Some(id)),
            now_ms,
        ),
        (Some(p), None) => classify_all(&for_identity_port(&all, p), now_ms),
        (None, _) => Expiry::Missing,
    };
    Ok(AuthStatus { identities, expiry, all })
}

/// Sign in with a token issued by the host's identity provider.
///
/// This is the flow that actually applies to a self-hosted `alt-p2p-lore-identity`: the
/// host runs `token issue <user>`, hands over a JWT, and the client files it under the auth
/// URL. There is no browser in it.
///
/// The token is passed to `lore` and never kept here. `lore` owns the credential store, and
/// a second copy in this app's keychain would be one more place for it to leak from without
/// being the one anything reads. Note `redact()` already hides `--token` wherever arguments
/// are logged — that is load-bearing, not decoration.
#[tauri::command]
pub async fn auth_login_token(
    app: AppHandle,
    token: String,
    token_type: String,
    auth_url: String,
) -> Result<String, String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("Paste the token your host issued you.".into());
    }
    if auth_url.trim().is_empty() {
        return Err("The auth URL is required — it must match the host's exactly.".into());
    }

    let cwd = neutral_cwd(&app);
    let out = cmd::run(
        &app,
        &cwd,
        vec![
            "auth".into(),
            "login".into(),
            "--token-type".into(),
            if token_type.trim().is_empty() { "lore".into() } else { token_type },
            "--token".into(),
            token,
            "--auth-url".into(),
            auth_url.trim().to_string(),
        ],
        Some(std::time::Duration::from_secs(60)),
    )
    .await
    .map_err(|e| e.to_string())?;

    // lore prints little on success; the caller re-reads `auth list` to confirm rather than
    // trusting an exit code to mean the token was accepted *and* stored.
    Ok(out.stdout)
}

/// Remove one stored identity.
///
/// Needed because signing in *adds* rather than replaces: two identities under one auth URL
/// leaves it to `lore` to choose which to use, and nothing in this app can predict that
/// choice. Removing the one you do not want is the only way to make it unambiguous.
#[tauri::command]
pub async fn auth_logout(app: AppHandle, auth_url: String, user_id: String) -> Result<(), String> {
    let cwd = neutral_cwd(&app);
    cmd::run(
        &app,
        &cwd,
        vec![
            "auth".into(),
            "logout".into(),
            "--auth-url".into(),
            auth_url,
            // Without --user-id this removes *every* identity for the URL. Always sent.
            "--user-id".into(),
            user_id,
        ],
        Some(std::time::Duration::from_secs(30)),
    )
    .await
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Drop the cached authorization for one repository, so the next call asks again.
///
/// A denial is cached like any other answer. When the host adds a grant, the client keeps
/// failing until the stored authorization token expires — fifteen minutes by default — and
/// nothing on screen suggests waiting. Observed end to end: the grant was in the database
/// the whole time while every retry reported "Not authorized", and the identity service
/// logged no request at all, because the client already had an answer.
///
/// **The resource is keyed by its bare id**, not `urc-<id>`. `lore auth logout --resource
/// urc-…` reports "Logged out" and removes nothing — the store keys it as the path segment
/// of the auth URL. That silent no-op cost an hour.
#[tauri::command]
pub async fn auth_refresh_access(
    app: AppHandle,
    auth_url: String,
    user_id: String,
    resource: String,
) -> Result<(), String> {
    let bare = resource.strip_prefix("urc-").unwrap_or(&resource).to_string();
    let cwd = neutral_cwd(&app);
    cmd::run(
        &app,
        &cwd,
        vec![
            "auth".into(),
            "logout".into(),
            "--auth-url".into(),
            auth_url,
            "--user-id".into(),
            user_id,
            "--resource".into(),
            bare,
        ],
        Some(std::time::Duration::from_secs(30)),
    )
    .await
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Sign in against a host, through the tunnel.
///
/// This opens a browser and waits for a person to finish there, so the timeout is generous
/// in a way no other lore call is: the alternative is cancelling someone mid-sign-in and
/// leaving them to guess whether it took.
#[tauri::command]
pub async fn auth_login(app: AppHandle, remote_url: String) -> Result<String, String> {
    let cwd = neutral_cwd(&app);
    let out = cmd::run(
        &app,
        &cwd,
        vec!["auth".into(), "login".into(), remote_url],
        Some(std::time::Duration::from_secs(300)),
    )
    .await
    .map_err(|e| {
        let raw = e.to_string();
        // Not translated to the expiry sentence: a *login* that fails on auth means the
        // host rejected the sign-in, and telling someone to sign in again is a loop.
        raw
    })?;
    Ok(out.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> String {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name);
        std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("missing {}: {e}", p.display()))
    }

    // 2026-08-14T05:11:52Z, the authentication token in the capture.
    const AUG_14: i64 = 1_786_684_312_000;

    #[test]
    fn a_real_capture_yields_both_tokens() {
        let list = parse_auth_list(&fixture("auth_list_typical.txt"));
        assert_eq!(list.len(), 2);

        let authn = &list[0];
        assert_eq!(authn.auth_url, "https://127.0.0.1:9443");
        assert_eq!(authn.user.as_deref(), Some("ale"));
        assert_eq!(authn.user_id.as_deref(), Some("u-87c4b8c8b7f44fc1"));
        assert_eq!(authn.resource, None);
        assert_eq!(authn.expires_ms, Some(AUG_14));

        // The second entry is scoped to one repository.
        assert_eq!(list[1].resource.as_deref(), Some("019f9e9f8f157e12a7ab77330299cfd4"));
    }

    #[test]
    fn a_repeated_domain_is_listed_once() {
        // The real output repeats `https://127.0.0.1:9443/`; showing it twice reads as a
        // misconfiguration the user then goes looking for.
        let list = parse_auth_list(&fixture("auth_list_typical.txt"));
        let d = &list[0].domains;
        assert_eq!(d.iter().filter(|x| *x == "https://127.0.0.1:9443/").count(), 1);
        assert!(d.contains(&"https://lore-identity.example/".to_string()));
    }

    #[test]
    fn nothing_stored_parses_as_nothing_rather_than_failing() {
        // `lore auth list` prints nothing and exits 0 when signed out. That is a state to
        // report, not an error to raise.
        assert!(parse_auth_list(&fixture("auth_list_empty.txt")).is_empty());
        assert_eq!(classify(None, AUG_14), Expiry::Missing);
    }

    #[test]
    fn a_session_finds_its_own_host_by_identity_port() {
        let list = parse_auth_list(&fixture("auth_list_two_hosts.txt"));
        assert_eq!(for_identity_port(&list, 9443)[0].user.as_deref(), Some("ale"));
        assert_eq!(for_identity_port(&list, 9444)[0].user.as_deref(), Some("daniel"));
        // A session whose host we hold no token for must not borrow another's.
        assert!(for_identity_port(&list, 9445).is_empty());
    }

    #[test]
    fn resource_tokens_are_not_identities() {
        // Both are filed under the same URL. The unscoped one is what ends the session when
        // it expires; a resource token is refreshed from it without a sign-in.
        let list = parse_auth_list(&fixture("auth_list_typical.txt"));
        let ids = for_identity_port(&list, 9443);
        assert_eq!(ids.len(), 1);
        assert_eq!(ids[0].resource, None);
    }

    #[test]
    fn two_users_under_one_auth_url_are_both_reported() {
        // Observed live: signing in as a second user *added* an identity rather than
        // replacing the first, because `lore` stores `[[remotes.token]]` as an array. The
        // earlier single-identity model picked whichever came first and so reported the
        // wrong user after a sign-in that had actually succeeded.
        let list = parse_auth_list(&fixture("auth_list_two_users.txt"));
        let ids = for_identity_port(&list, 9443);
        let users: Vec<_> = ids.iter().filter_map(|i| i.user.as_deref()).collect();
        assert_eq!(users, vec!["ale", "uitest"]);
    }

    #[test]
    fn the_soonest_expiry_speaks_for_the_whole_set() {
        // We cannot know which identity `lore` will use, so the safe reading is the one that
        // runs out first. Reporting the later one would show green while the identity
        // actually in use had expired.
        let list = parse_auth_list(&fixture("auth_list_two_users.txt"));
        let ids = for_identity_port(&list, 9443);
        // 05:11 (ale) is before 07:49 (uitest); at 04:30 that is 41 minutes away.
        let now = 1_786_684_312_000 - 41 * 60_000;
        assert_eq!(classify_all(&ids, now), Expiry::Soon(41));
    }

    #[test]
    fn a_pinned_identity_is_judged_on_its_own_clock() {
        // Reported from testing: a workspace pinned to uitest still showed
        // "ale, uitest — ale expires in 5h52m". ale's clock is nothing to do with work that
        // acts as uitest.
        let list = parse_auth_list(&fixture("auth_list_two_users.txt"));
        let ids = for_identity_port(&list, 9443);
        let uitest = ids.iter().find(|i| i.user.as_deref() == Some("uitest")).copied();
        let ale = ids.iter().find(|i| i.user.as_deref() == Some("ale")).copied();

        // 04:30 UTC: ale (05:11) has 41 minutes, uitest (07:49) has over three hours.
        let now = 1_786_684_312_000 - 41 * 60_000;
        assert_eq!(classify(ale, now), Expiry::Soon(41));
        assert!(matches!(classify(uitest, now), Expiry::Valid(_)));
        // And the set still reports the soonest, which is right when nothing is pinned.
        assert_eq!(classify_all(&ids, now), Expiry::Soon(41));
    }

    #[test]
    fn a_pin_to_someone_not_signed_in_is_missing() {
        // The state behind "No token stored": pinned to a user whose token is gone.
        let list = parse_auth_list(&fixture("auth_list_two_users.txt"));
        let ids = for_identity_port(&list, 9443);
        let absent = ids.iter().find(|i| i.user.as_deref() == Some("nobody")).copied();
        assert_eq!(classify(absent, 0), Expiry::Missing);
    }

    #[test]
    fn one_unreadable_expiry_makes_the_whole_set_unknown() {
        // A readable sibling must not vouch for one we could not parse.
        let list = parse_auth_list(
            "Auth URL: https://127.0.0.1:9443\n  User: a (u-1)\n  Expires: Fri, 14 Aug 2026 05:11:52 +0000\n\
             Auth URL: https://127.0.0.1:9443\n  User: b (u-2)\n  Expires: whenever\n",
        );
        let ids = for_identity_port(&list, 9443);
        assert_eq!(ids.len(), 2);
        assert_eq!(classify_all(&ids, 0), Expiry::Unknown);
    }

    #[test]
    fn no_identity_for_a_port_is_missing_not_unknown() {
        assert_eq!(classify_all(&[], 0), Expiry::Missing);
    }

    #[test]
    fn expiry_is_classified_by_how_long_is_left() {
        let list = parse_auth_list(&fixture("auth_list_typical.txt"));
        let id = for_identity_port(&list, 9443)[0];

        assert!(matches!(classify(Some(id), AUG_14 - 5 * 3_600_000), Expiry::Valid(_)));
        assert_eq!(classify(Some(id), AUG_14 - 30 * 60_000), Expiry::Soon(30));
        assert_eq!(classify(Some(id), AUG_14 + 90 * 60_000), Expiry::Expired(90));
    }

    #[test]
    fn the_boundary_warns_rather_than_reassures() {
        // Exactly at the threshold, and one minute inside it, both warn. Erring the other
        // way means the last warning before expiry is a green one.
        let list = parse_auth_list(&fixture("auth_list_typical.txt"));
        let id = for_identity_port(&list, 9443)[0];
        assert_eq!(classify(Some(id), AUG_14 - WARN_WITHIN_MINUTES * 60_000), Expiry::Soon(60));
        assert!(matches!(
            classify(Some(id), AUG_14 - (WARN_WITHIN_MINUTES + 1) * 60_000),
            Expiry::Valid(_)
        ));
    }

    #[test]
    fn an_already_expired_token_reports_expired() {
        let list = parse_auth_list(&fixture("auth_list_expired.txt"));
        let id = for_identity_port(&list, 9443)[0];
        assert!(matches!(classify(Some(id), AUG_14), Expiry::Expired(_)));
    }

    #[test]
    fn an_unreadable_date_is_unknown_and_never_valid() {
        // The failure that would matter: a format change turning every token green.
        let list = parse_auth_list(
            "Auth URL: https://127.0.0.1:9443\n  Expires: sometime next week\n",
        );
        assert_eq!(list[0].expires_ms, None);
        assert_eq!(list[0].expires_raw.as_deref(), Some("sometime next week"));
        assert_eq!(classify(Some(&list[0]), AUG_14), Expiry::Unknown);
    }

    #[test]
    fn dates_convert_against_known_instants() {
        assert_eq!(parse_rfc2822_ms("Thu, 1 Jan 1970 00:00:00 +0000"), Some(0));
        assert_eq!(parse_rfc2822_ms("Fri, 14 Aug 2026 05:11:52 +0000"), Some(AUG_14));
        // A leap day, and a year divisible by 100 but not 400 having none.
        assert_eq!(parse_rfc2822_ms("Sat, 29 Feb 2020 00:00:00 +0000"), Some(1_582_934_400_000));
        assert_eq!(parse_rfc2822_ms("Wed, 1 Mar 1900 00:00:00 +0000"), Some(-2_203_891_200_000));
    }

    #[test]
    fn a_zone_offset_is_applied_in_the_right_direction() {
        // +0200 is two hours *ahead*, so the same wall clock is an earlier instant. Getting
        // the sign backwards would shift every deadline by four hours.
        let utc = parse_rfc2822_ms("Fri, 14 Aug 2026 05:11:52 +0000").unwrap();
        assert_eq!(parse_rfc2822_ms("Fri, 14 Aug 2026 07:11:52 +0200"), Some(utc));
        assert_eq!(parse_rfc2822_ms("Fri, 14 Aug 2026 03:11:52 -0200"), Some(utc));
        assert_eq!(parse_rfc2822_ms("Fri, 14 Aug 2026 05:11:52 GMT"), Some(utc));
    }

    #[test]
    fn junk_dates_are_rejected_rather_than_coerced() {
        for bad in [
            "",
            "not a date",
            "Fri, 14 Xxx 2026 05:11:52 +0000",
            "Fri, 14 Aug 2026 05:11:52 +99",
            "Fri, 14 Aug 2026 0511 +0000",
        ] {
            assert_eq!(parse_rfc2822_ms(bad), None, "should not parse: {bad:?}");
        }
    }

    #[test]
    fn a_resource_id_is_stripped_to_the_form_the_store_uses() {
        // `lore auth logout --resource urc-<id>` reports "Logged out" and removes nothing:
        // the store keys the resource as the auth URL's path segment, which is the bare id.
        // A silent no-op, and the reason a grant appeared not to work.
        let strip = |r: &str| r.strip_prefix("urc-").unwrap_or(r).to_string();
        assert_eq!(strip("urc-019f9e9f"), "019f9e9f");
        assert_eq!(strip("019f9e9f"), "019f9e9f");
    }

    #[test]
    fn an_auth_failure_is_told_apart_from_every_other_failure() {
        assert!(looks_like_auth_failure(
            "Operation not supported: authentication requires a configured auth endpoint"
        ));
        assert!(looks_like_auth_failure("status: Unauthenticated, message: token expired"));
        assert!(looks_like_auth_failure("HTTP 401 Unauthorized"));
        // Things that must not be mistaken for it: they send the user somewhere else.
        assert!(!looks_like_auth_failure("connection refused"));
        assert!(!looks_like_auth_failure("no such file or directory"));
        assert!(!looks_like_auth_failure("the repository is locked by someone else"));
    }
}
