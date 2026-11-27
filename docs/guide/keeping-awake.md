# Keeping the computer awake

[Back to the guide](README.md)

Helpers can work for a long time. If your computer goes to sleep because nobody touched it, the work
pauses until it wakes.

## The setting

In the settings (⚙ at the foot of the chat list), under **General**:

**Keep this computer awake while helpers are working**: stops the computer going to sleep on its
own while agents work. Closing the lid or choosing Sleep still works.

It is on by default.

## What it does, and what it does not

- It only stops the computer **falling asleep on its own** while any helper is working.
- About five seconds after the last helper stops working, your normal sleep settings apply again.
- The screen can still turn off on its usual schedule.
- **Closing the lid, pressing the power button or choosing Sleep still put the computer to sleep at
  once.**
- If Masthead stops or crashes, the hold ends with it.
- Turning the setting off releases the hold at once.

If the computer did sleep while a chat was working, the chat says so when it wakes: "This computer
was asleep from … to …; work carried on afterwards."

## How it works on each system

| System | What Masthead uses |
|---|---|
| Windows | A small PowerShell helper that asks Windows not to idle to sleep |
| macOS | `caffeinate`, built into macOS |
| Linux | `systemd-inhibit` (part of systemd) |

`masthead doctor` shows a **Keep awake** line. If it says the tool was not found, the computer may
sleep while agents work: on Linux, install systemd, or keep the computer awake yourself.
