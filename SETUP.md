# Setting up alt-lore Desktop

Install the app (Mac: open the `.dmg`, drag to Applications · Windows: run the installer) and
launch it. Everything the app needs — the Lore tools, the peer-to-peer tunnel, a Java runtime —
is inside the app. There is nothing else to install.

To **connect to a host**, you need details from whoever runs it. There are two kinds:

- **A direct host** — a machine you can already reach (same LAN or VPN). You need its address,
  like `grpc://192.168.1.50:41337`. Add it under **Hosts → + Host**, pick *direct*.
- **A P2P host** — reached across the internet through an encrypted tunnel. You need the
  coordination server address, the session name, and the pre-shared key. Add them under
  **Hosts → + Host**; the key is stored in your OS keychain.

Then **Connect**, and clone a repository with **+ Clone**. A green dot means a direct
connection; orange means the tunnel fell back to a relay (normal on strict networks — still
end-to-end encrypted).

## If the host requires sign-in (identity hosts)

Three things live on *your machine*, not in the repository — a new computer needs all three,
and each fails with a message that doesn't obviously name it:

1. **The identity port.** In the host's settings in the app, fill in the identity port the
   host's operator gives you (often `9443`). It is not a free choice — it must match what the
   host advertises. *Symptom when missing: the app never offers a sign-in at all.*

2. **A sign-in.** Get a login token from the host's operator and sign in from the app. Tokens
   expire (commonly 12 hours); the app warns you before that happens. *Symptom when missing or
   expired: "Not authenticated" / "your access has expired."*

3. **The host's CA certificate** — only for hosts using a private certificate authority. Ask
   the operator for their CA file and add it to your computer's trust store; the app will tell
   you when this is the problem ("This machine does not trust the host's identity
   certificate…"). One-time step per machine:

   **macOS**
   ```
   security add-trusted-cert -r trustRoot -p ssl \
     -k ~/Library/Keychains/login.keychain-db <ca-file.pem>
   ```
   **Windows** (PowerShell)
   ```
   Import-Certificate -FilePath <ca-file.crt> -CertStoreLocation Cert:\CurrentUser\Root
   ```
   **Linux** (for the `lore` CLI; the desktop app does not ship for Linux yet)
   ```
   sudo cp <ca-file.pem> /usr/local/share/ca-certificates/host-ca.crt && sudo update-ca-certificates
   ```

## Good to know

- **One P2P tunnel per host.** Two configured sessions to the same host can't both connect —
  the identity port binds once. Disconnect one before connecting the other.
- **Locks are advisory.** They make who-is-working-on-what visible; they don't physically stop
  anyone. On hosts without sign-in, lock owners can't be told apart.
- **The debug console** (bottom panel, enable Debug in Settings) streams every Lore command the
  app runs — when something fails, the answer is usually right there.

## Requirements

macOS (Apple Silicon) or Windows 10/11. Nothing else — no Java, no CLI tools, no accounts,
except what the host you're connecting to requires.
