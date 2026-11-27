# Remote access: the first real try (manual)

> **History.** This plan was carried out for 0.2.0 (the record of the first real try). It is kept as the record of the design and the evidence; where it
> differs from the code, the code and `docs/wiki/` are right.

Everything in remote access has been tested only against a fake Tailscale (`test/remote*.test.ts`).
These steps are the first time it touches the real one. They are for the person, on their own
machine, once. Each step says what should happen; stop at the first one that does not and note what
you saw.

## Done on 2026-11-27 (Tailscale 1.104.7, Linux)

Steps 1 to 3 passed: switching on through `sudo tailscale serve --bg --https=7443 unix:…` (being the
operator was not enough), a phone paired and used fully, and from a second device by script the
`read` and `approve` roles were enforced, a role lowered in place on an open socket, and revoke closed
it with 4001. Found on the way: a test server on the same machine removed the real entry at its start
(fixed: one socket per data folder, test servers never run `tailscale`), and a Windows device with
"Use Tailscale DNS" off could not resolve the address.

## Before

- Tailscale is installed, signed in and connected on this computer and on a phone or second computer.
- HTTPS certificates are on for the tailnet (Tailscale admin console → DNS → HTTPS).
- Note what `tailscale serve status` shows now. Masthead must leave every line of it as it is.

## 1. Switch it on

1. In Masthead's settings, turn on **Remote access** (port 7443 unless changed).
2. **Expected:** either it turns on, or it says Tailscale needs your password once and shows
   `sudo tailscale serve --bg --https=7443 unix:/run/user/<uid>/masthead/remote.sock` (on Windows:
   run Tailscale as an administrator). Run that command once in a terminal, then switch it on again;
   it must now turn on. (Being the Tailscale operator is not enough for a socket target: Tailscale
   answers "401 Unauthorized: must be root, or be an operator and able to run 'sudo tailscale' to
   serve a path or Unix socket".) The **Allow my other devices to connect** box must be unticked
   while the status says Off.
3. **Check:** `tailscale serve status` shows the earlier lines unchanged plus one new entry,
   `https://<this machine>.<tailnet>.ts.net:7443`, pointing at
   `unix:/run/user/<uid>/masthead/remote.sock` (Linux) or `http://127.0.0.1:7719` (Windows).
   Nothing says Funnel.

## 2. Pair a device

1. On the phone, open the address shown in the settings, `https://<this machine>.<tailnet>.ts.net:7443`.
2. **Expected on the phone:** a page asking for approval, with a six-digit code.
3. **Expected on this computer:** a card naming the phone (device name, system, Tailscale user and
   address) with the same code. Check that the codes match, then choose **Allow**.
4. **Expected on the phone:** Masthead opens and works like the local page: conversations, sending,
   answering approvals.
5. Try a phone that is not allowed, or **Deny** a second request. **Expected:** it cannot get in;
   asking again is refused for about ten minutes.

## 3. Roles, revoke, audit

1. In the device list, set the phone to **Read only**. **Expected:** it can still read, but sending a
   message is refused.
2. **Revoke** the phone. **Expected:** its page drops at once and asks for approval again on reload.
3. Open the audit log. **Expected:** switching on, the request, the approval, the connection, the role
   change and the revoke, each with the time and the device.

## 4. Restart and switch off

1. Restart Masthead with remote access still on. **Expected:** the serve entry is still there and an
   allowed device reconnects without asking again.
2. Switch remote access **off**. **Expected:** only Masthead's line goes from `tailscale serve
   status`. The phone's page stops working.
3. Restart Masthead with it off. **Expected:** no serve entry comes back.

## What to report

For each step: what happened, and the output of `tailscale serve status` before and after step 1 and
step 4.2. Replace the tailnet name and addresses with placeholders before sharing the output.
