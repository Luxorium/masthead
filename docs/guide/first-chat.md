# Your first chat

[Back to the guide](README.md)

1. Run `masthead` (or use its entry in your app launcher). Your browser opens on Masthead.
2. A new chat shows **What are we working on?** If you are in another chat, choose **New chat** at
   the top of the chat list.
3. Under the message box, press **Folder** and choose the folder to work in.
   **Agents can read and change files in this folder.** Pick the project folder, not your whole
   home folder. A chat keeps its folder; to work somewhere else, start a new chat.
4. If you have more than one team, a **Uses …** button (for example **Uses Claude**) next to the
   folder shows which team this chat will use. You
   can change it before you send the first message. See
   [Teams and agent programs](teams-and-agent-programs.md).
5. In the box that says **Ask for anything**, write what you want in your own words. For example:
   - Look through this folder and tell me what this project does.
   - Find and fix the failing tests, then explain what was wrong.
   - Write a short README for this project.
6. Press the **↑** button (**Send**), or Enter.
7. The answer appears in the chat. While it works you see **Working…** or **Thinking…**.

## While it works

- **You can add to it.** Type in the box ("Add to what … is doing") and send: the main assistant
  reads it at its next step.
- **It may ask you something.** A card such as **Question from …** or **Permission request from …**
  appears above the message box. Choose an answer, or **Allow**, **Allow for this session** or
  **Deny**. Chats waiting for you are marked **Needs your answer** in the chat list.
- **It may bring in helpers.** See [Helpers and the team](helpers-and-team.md).
- **When the main assistant asks you something**, a **Waiting for your answer** button takes you
  to its question.
- **To stop**, press the **■ Stop** button, which takes the place of **↑** while the main
  assistant is working and the box is empty. **Stop all** also stops every helper.
- **Closing the browser tab stops nothing.** The work carries on and the page catches up when you
  come back. Stopping Masthead itself (`masthead stop`) stops the work.

## When to ask you

In the settings (⚙ at the foot of the chat list), **When to ask you** chooses how often agents ask
before they act:

| Choice | Meaning |
|---|---|
| **As set in Claude Code** | Follows your own Claude Code settings (the default) |
| **Always ask** | Asks before anything that needs permission |
| **Ask, except for file edits** | Edits files in the folder without asking |
| **Decide automatically** | Lets the program decide what is safe |
| **Never ask (risky)** | Every agent can run any command and change any file without asking |

## Managing chats

- Your chats are listed on the left. **Hide chats** and **Show chats** fold the list away.
- To rename a chat, click its title at the top of the page (**Rename**).
- **Delete chat** asks **Delete?** once more before it removes it.
