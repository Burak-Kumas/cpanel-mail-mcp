# Mail MCP Setup

Connects your mailbox to Claude. Claude can read, search and draft email, send
it with your approval, and see your calendar.

**Takes about 2 minutes.** You run one command and enter your email address and
password. Nothing else.

> Türkçe rehber: **[KURULUM.md](KURULUM.md)**

---

## First: is Node.js installed?

Open Terminal (on a Mac, type `Terminal` in Spotlight) and run:

```bash
node --version
```

If you see `v20` or higher, you're ready. Skip ahead.

If the command isn't found, download and install the **LTS** version from
https://nodejs.org, then close and reopen Terminal.

---

## Setup

Paste this into Terminal and press Enter:

```bash
npx -y --allow-remote=all https://github.com/Burak-Kumas/cpanel-mail-mcp/archive/refs/heads/main.tar.gz setup
```

It will ask for your cPanel mailbox details:

1. **Username**: your full email address, e.g. `name@company.com`
2. **Password**: hidden while you type, that's normal
3. **Server (host)**: default `mail.yourdomain.com`
4. **IMAP port**: default `993`
5. **SMTP port**: default `465`

All of these are shown in cPanel > Email Accounts > **Connect Devices**, under
*Secure SSL/TLS Settings*. If the value in brackets is correct, just press
Enter.

> Use the password of the mailbox itself, not your cPanel/webmail **login**
> password. If they're the same, that's fine.

Before saving, it actually tries an IMAP and SMTP login; if something is wrong,
it asks again. It finds your calendar on its own.

When it's done, **fully quit and reopen Claude.**

---

## How do I know it works?

Ask Claude:

- "List the last 10 emails in my inbox"
- "Search for emails from Jane"
- "Show my calendar for this week"

Claude will ask for permission the first time. Approve it.

---

## What can it do?

| What | Details |
|---|---|
| List & search | Messages in any folder; search by sender, subject, date or content |
| Read | The full message, with attachments |
| Send | Sends with your approval, can attach files |
| Reply | Keeps the thread intact, supports "reply all" |
| Forward | Forwards with attachments |
| Draft | Saves to Drafts, **does not send** |
| Attachments | Lists attachments and saves them to your computer |
| Organize | Read/unread, star, archive, move to spam |
| Delete | Moves to Trash (reversible) |
| Folders | Create, rename, delete |
| Calendar | View, create, update and delete events |

**Safety limits:** Deleting moves a message to Trash, so you can undo it.
Permanent deletion is **off** by default, so Claude can't accidentally destroy
an email for good. The Inbox folder can't be deleted.

---

## Troubleshooting

**`npx: command not found`**
Node.js isn't installed. Go back to "First" above.

**`npm error code EALLOWREMOTE`** or **`EALLOWGIT`**
You ran the command without `--allow-remote=all`. npm 12 and later block
installing packages from a URL by default. Copy the command above exactly; the
permission only applies to this one install.

**Should I use `sudo`?**
No. `sudo` isn't needed, and it installs everything for the `root` account
instead of you, so Claude can't find the server. If you already tried with
`sudo`, fix npm's cache ownership with `sudo chown -R $(whoami) ~/.npm`.

**It says the login failed**
The password is wrong. Remember: the mailbox password, not your cPanel login.
If you can log in to webmail (`https://webmail.yourdomain.com`) with it, it's
correct.

**I don't know the server name or ports**
Look in cPanel > Email Accounts > **Connect Devices**, under *Secure SSL/TLS
Settings*: Incoming Server (IMAP, 993) and Outgoing Server (SMTP, 465) are
listed there.

**Setup finished but Claude can't see my mail**
Fully quit and reopen Claude (closing the window isn't enough; on a Mac use
`Cmd+Q`).

**I changed my password**
Run the same setup command again and enter the new password.

---

## Security

Setup runs **on your own computer**. Your password is stored only in
`~/.cpanel-mail-mcp/.env` on your machine, readable only by you. It is never
sent to a central server, to us or to anyone else. Nobody can access your
mailbox, and you can't access anyone else's.

Claude asks for your approval every time before sending an email. Read the
recipient and content before approving.

If your password was ever exposed (a screenshot, a chat, an email), change it
in cPanel right away and run the setup command again.
