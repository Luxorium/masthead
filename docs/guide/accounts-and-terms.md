# Your account, API keys and the terms

[Back to the guide](README.md)

## Notice

Masthead is an independent open-source project, not affiliated with, endorsed by or sponsored by
Anthropic or OpenAI. "Claude", "Claude Code", "OpenAI", "Codex" and "ChatGPT" are trademarks of
their owners, used only to describe compatibility.

Masthead does not provide, proxy, store or resell model access: it runs the official Claude Code and
Codex CLI installed on your computer, under your own account, and your plan's usage limits apply.
You are responsible for following Anthropic's and OpenAI's terms.

Anthropic says Pro/Max plans are meant for ordinary individual use and recommends API keys for Agent
SDK tools, so running many agents on a subscription may hit limits or be restricted. Use an API key
if you need certainty.

## Which account Masthead uses

Masthead never asks for a password or a key. Every helper runs your own `claude` (or `codex`)
program, and that program uses whatever account it is signed in with. So to change the account
Masthead uses, you change how Claude Code (or Codex) is signed in, then restart Masthead
(`masthead stop`, then `masthead`; in Windows PowerShell `masthead.cmd stop`, then `masthead.cmd`).

## Claude Code with a Claude Console account (API billing)

You need an account at the [Claude Console](https://platform.claude.com), with billing set up.

1. Open a terminal (on Windows, PowerShell) and run `claude`.
2. If it is signed in with a Pro or Max plan, type `/logout` and press Enter, then run `claude` again.
   (Logging out also takes you through Claude Code's first-run setup again.)
3. At the sign-in choice, pick the **Anthropic Console account**, and sign in in the browser.
   Claude Code may ask how to sign in:
   - **Sign in with your Console account** (recommended by Claude Code): no API key is made; Claude
     Code keeps the sign-in and renews it.
   - **Create an API key**: Claude Code makes a Console API key and keeps it for you.
   Either way, use is billed to your Console account, not to a Pro or Max plan.
4. Type `/status` to check which account is in use, then close Claude Code.
5. Restart Masthead.

This sign-in is kept by Claude Code itself, so it also works when Masthead starts at login as a
service.

**With your own API key instead.** Claude Code also uses an API key from the `ANTHROPIC_API_KEY`
environment variable, ahead of a plan sign-in, and Masthead passes it on untouched. But it only
reaches Masthead if Masthead is started from a terminal where the variable is set: the service that
starts Masthead at login does not get it. If you use the service, prefer step 3 above. To go back to
your plan, remove the variable (`unset ANTHROPIC_API_KEY` in that terminal) and restart Masthead.

Claude Code's own page on this: [Authentication](https://code.claude.com/docs/en/authentication).

## Codex with an OpenAI API key

You need an API key from [platform.openai.com/api-keys](https://platform.openai.com/api-keys).
Use is billed at API rates, not against a ChatGPT plan.

1. In a terminal, put the key in the `OPENAI_API_KEY` variable, then run:
   ```sh
   printenv OPENAI_API_KEY | codex login --with-api-key
   ```
2. Check with `codex login status`. (`codex logout` removes the sign-in.)
3. In Masthead's settings, under **Agents on this computer**, press **Check again**: Codex should say
   **Ready**.

OpenAI's page on this: [Codex authentication](https://learn.chatgpt.com/docs/auth). It shows the
command for macOS and Linux only; on Windows, see that page or run it from Git Bash or WSL.
