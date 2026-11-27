# Remote access: the first real try (manual)

Everything in remote access has been tested only against a fake Tailscale (`test/remote*.test.ts`).
These steps are the first time it touches the real one. They are for the person, on their own
machine, once. Each step says what should happen; stop at the first one that does not and note what
you saw.

## Before

- Tailscale is installed, signed in and connected on this computer and on a phone or second computer.
- HTTPS certificates are on for the tailnet (Tailscale admin console → DNS → HTTPS).
- Note what `tailscale serve status` shows now. Masthead must leave every line of it as it is.

## 1. Switch it on

1. In Masthead's settings, turn on **Remote access** (port 7443 unless changed).
2. **Expected:** either it turns on, or it says Tailscale did not let it and shows a command such as
   `sudo tailscale set --operator=<you>`. In that case run that command once in a terminal, then
   switch it on again.
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
