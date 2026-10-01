// Mint a session token for local testing without Google:
//   SESSION_SECRET=dev bun scripts/dev-session.ts you@example.com "Your Name"
// Web: set cookie vibez_session=<token> on localhost. Mac:
//   mkdir -p ~/Library/Application\ Support/Vibez && printf %s <token> > ~/Library/Application\ Support/Vibez/session-token && chmod 600 ~/Library/Application\ Support/Vibez/session-token
import { createSessionToken } from "../src/auth";

const [email, name = email?.split("@")[0] ?? ""] = process.argv.slice(2);
const secret = process.env.SESSION_SECRET;
if (!email || !secret) {
  console.error('usage: SESSION_SECRET=... bun scripts/dev-session.ts <email> ["Full Name"]');
  process.exit(1);
}
console.log(createSessionToken({ email, name, givenName: name.split(" ")[0], picture: null }, secret, Date.now()));
