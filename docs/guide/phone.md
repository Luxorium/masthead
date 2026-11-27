# Using Masthead from your phone

You can use Masthead from a phone, tablet or another computer, as long as both are on your own
Tailscale network. Nothing is opened to the internet, and a device gets in only after you allow it.

> This has been tested only with a stand-in for Tailscale so far. If something here does not match
> what you see, please say what happened.

## What you need

- Tailscale installed, signed in and connected, on this computer and on the phone.
- HTTPS certificates switched on for your tailnet: in the Tailscale admin console, **DNS → HTTPS
  Certificates → Enable**.

## Set up

1. On this computer, open Masthead, then **Settings → Remote access**.
2. Turn on **Allow my other devices to connect**.
3. One of these happens:
   - It says **On** and shows an address like `https://<computer>.<tailnet>.ts.net:7443`. Go on to the
     next part.
   - It says Tailscale did not let Masthead change its settings, and shows a command such as
     `sudo tailscale set --operator=<you>`. Copy it, run it once in a terminal, then turn the switch on
     again. (On Windows, run Tailscale as an administrator instead.)
   - It says the port already serves something else. Turn the switch off, choose another port, and
     turn it on again.

## Allow your phone

1. On the phone, open the address from the settings.
2. The phone shows **Open Masthead on this device** and a button **Ask for access**. Tap it.
3. The phone shows a six-digit code, for example **482 913**, and "Waiting for approval…".
4. On this computer a card appears: "*phone* wants to use Masthead", with the phone's name, system,
   Tailscale user and address, and the same code.
5. **Check that the two codes are the same.** If they are not, choose **Deny**.
6. Choose what the phone may do (**Everything**, **Answer approvals and stop work**, or **Only read**),
   then **Allow**.
7. The phone opens Masthead. You can now use it as on this computer, within what you chose.

The phone stays allowed for 30 days after its last use. After that it asks again.

## Manage devices

In **Settings → Remote access**, under **Allowed devices**:

- change what a device may do (it applies at once);
- **Remove** a device (its page closes at once, and it must ask again);
- see when each device was last used and until when it is allowed.

**Show recent activity** lists who asked, who was allowed or removed, and who connected.

## On the phone itself

In the phone's Settings, **This device** says: "This browser stays signed in to Masthead until you
forget it here, or the computer removes it." If the device may only follow along, it says so (for
example "This device can follow the chats but not change anything.").

**Forget this device** signs this browser out and removes it from the computer's list. Use it on a
phone or computer that is not yours.

## Turn it off

Turn off **Allow my other devices to connect**. Masthead removes only its own entry from Tailscale;
your other Tailscale settings stay as they were. Phones lose access at once. Allowed devices are
remembered for when you turn it on again.

## On Windows

The settings show a warning: on Windows, other programs on the computer, including ones run by other
user accounts, could pretend to be one of your devices. They still cannot get in unless you allow
them. Allow a device only while you are pairing it yourself, and only when the codes match.

## Troubleshooting

| What you see | What to do |
|---|---|
| "Tailscale is not available on this computer" | Install Tailscale, sign in, and make sure it is connected. |
| "HTTPS certificates are switched off" | Enable HTTPS certificates in the Tailscale admin console. |
| A command to run, e.g. `sudo tailscale set --operator=…` | Run it once in a terminal, then switch on again. |
| "Port … already serves something else" or mentions Funnel | Choose another port while the switch is off. |
| The phone cannot open the address | Check that the phone is connected to Tailscale and the switch is on. |
| The phone says "This computer does not accept this device" | It may be a device of another tailnet or a tagged device; allow those in the settings if you mean to. |
| "A request from this device is already waiting" | Approve or deny the waiting card on this computer, or wait 10 minutes. |
| The phone says "This computer withdrew access" | The device was removed; tap **Ask again**. |

## Related pages

How it works, for developers: [Remote access](../wiki/Remote-Access.md) · [Security model](../wiki/Security-Model.md) · Back to the [user guide](README.md)
