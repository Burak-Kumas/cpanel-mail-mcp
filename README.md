<div align="center">

```
 __  __    _    ___ _       __  __  ____ ____
|  \/  |  / \  |_ _| |     |  \/  |/ ___|  _ \
| |\/| | / _ \  | || |     | |\/| | |   | |_) |
| |  | |/ ___ \ | || |___  | |  | | |___|  __/
|_|  |_/_/   \_\___|_____| |_|  |_|\____|_|
```

# cpanel-mail-mcp

**Connect your cPanel mailbox to Claude.** · **cPanel posta kutunu Claude'a bağla.**

IMAP · SMTP · CalDAV · stdio MCP

![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=nodedotjs&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-stdio-6E56CF)
![cPanel](https://img.shields.io/badge/cPanel-IMAP%20%C2%B7%20SMTP%20%C2%B7%20CalDAV-FF6C2C?logo=cpanel&logoColor=white)
![Claude](https://img.shields.io/badge/Claude-Code%20%26%20Desktop-D97757?logo=anthropic&logoColor=white)

**[English](#english)** · **[Türkçe](#türkçe)**

</div>


---

## English

A stdio MCP server for cPanel mailboxes. It plugs straight into Claude Code and
the Claude desktop app; no OAuth shim, reverse proxy or always-on server needed.

> Step-by-step guide for non-technical teammates: **[SETUP.md](SETUP.md)** · Türkçe: **[KURULUM.md](KURULUM.md)**

### 🚀 Install

```bash
npx -y --allow-remote=all https://github.com/Burak-Kumas/cpanel-mail-mcp/archive/refs/heads/main.tar.gz setup
```

| Step | What happens |
|:---:|---|
| **1** | The wizard asks for the cPanel mailbox username, password, server and IMAP/SMTP ports. Server and ports come pre-filled with the cPanel defaults. |
| **2** | Before saving, it verifies them with a real IMAP and SMTP login and detects whether a calendar is available. |
| **3** | It registers the server with both Claude Code and the desktop app. |

The server is installed under `~/.cpanel-mail-mcp/` (copied to a permanent
directory because the npx cache is temporary), and settings are kept in
`~/.cpanel-mail-mcp/.env` with mode `600`.

> [!NOTE]
> Installation uses GitHub's `.tar.gz` archive instead of git. npm 12 and later
> refuse both `github:` sources (`EALLOWGIT`) and URL tarballs (`EALLOWREMOTE`)
> by default; `--allow-remote=all` allows the tarball for this one run only and
> leaves your global npm config untouched. Don't use `sudo`.

### 🧰 Tools

| Group | Tools |
|---|---|
| 📥 **Read** | `list_folders` · `list_messages` · `search_messages` · `get_message` · `list_attachments` · `save_attachment` |
| ✉️ **Write** | `send_message` (with attachments) · `reply_message` (keeps thread headers and quote, supports `replyAll`) · `forward_message` (with attachments) · `create_draft` |
| 🗂️ **Organize** | `set_flags` (seen/flagged/answered) · `move_message` · `archive_message` · `mark_spam` · `trash_message` |
| 📁 **Folders** | `create_folder` · `rename_folder` · `delete_folder` · `empty_trash` |
| 📅 **Calendar** | `list_calendars` · `list_events` · `create_event` · `update_event` · `delete_event` (only when `CALDAV_URL` is set) |

> [!IMPORTANT]
> **Permanent delete:** `delete_message` is only exposed when `ALLOW_DELETE=true`.
> It is off by default; regular deletion uses `trash_message`, which moves mail
> to Trash and can be undone. The `INBOX` folder cannot be deleted.

### 🔒 Design decision

The server runs **one mailbox per process**. Everyone runs their own instance
on their own machine with their own credentials; the password never leaves that
machine.

A central deployment was deliberately ruled out: cPanel mail has no OAuth or
app passwords, so a central server would have to store everyone's plain IMAP
password. That password grants full rights to read the mailbox **and send mail
as that person**; a single breach would expose the whole team's correspondence.

### 🛠️ Development

```bash
git clone https://github.com/Burak-Kumas/cpanel-mail-mcp.git
cd cpanel-mail-mcp
npm install
npm run build
cp .env.example .env   # fill in your own values
npm start
```

`build/` is committed so the `npx` tarball install works without a build step.
After changing the source, run `npm run build` and commit the `build/` output
too.

<details>
<summary><b>📝 Technical notes</b></summary>

- Settings are read from the `.env` file in the server's own directory; real
  environment variables take precedence when set.
- cPanel's `cpdavd` returns the wrong `href` in multistatus responses, so CalDAV
  discovery is done by hand (`tsdav`'s automatic discovery fails on these
  servers with "cannot find homeUrl").
- The drafts folder is found via the IMAP `SPECIAL-USE` flag; on cPanel it is
  `INBOX.Drafts`, not `Drafts`.
- The desktop app does not load the user's shell, so registration uses an
  absolute path instead of `node` (nvm is a shell function and does not resolve
  in the desktop app).
- SMTP delivery does not put anything in Sent; the sent message is written there
  separately with IMAP `APPEND`. The message is compiled once and both sent and
  filed, so both copies share the same `Message-ID`.
- When sending `raw`, nodemailer does not read recipients from the headers; the
  envelope is passed separately via `MailComposer.getEnvelope()` (it also
  carries Bcc).
- Message bodies are decoded with `mailparser`; slicing headers out of the raw
  source produced unreadable output for multipart and base64-encoded messages.

</details>

<div align="right"><a href="#cpanel-mail-mcp">↑ Back to top</a></div>

---

## Türkçe

cPanel posta kutuları için stdio MCP sunucusu. Claude Code ve Claude masaüstü
uygulamasına doğrudan bağlanır; OAuth shim, reverse proxy veya sürekli açık bir
sunucu gerekmez.

> Ekip üyeleri için adım adım kurulum rehberi: **[KURULUM.md](KURULUM.md)**
>
> Not: Kurulum sihirbazı ve araç çıktıları İngilizcedir.

### 🚀 Kurulum

```bash
npx -y --allow-remote=all https://github.com/Burak-Kumas/cpanel-mail-mcp/archive/refs/heads/main.tar.gz setup
```

| Adım | Ne olur |
|:---:|---|
| **1** | Sihirbaz cPanel posta hesabının kullanıcı adını, şifresini, sunucusunu ve IMAP/SMTP portlarını sorar. Sunucu ve portlar cPanel varsayılanlarıyla dolu gelir. |
| **2** | Kaydetmeden önce gerçek bir IMAP ve SMTP girişiyle doğrular, takvimin var olup olmadığını kendisi tespit eder. |
| **3** | Hem Claude Code'a hem masaüstü uygulamasına kaydeder. |

Kurulum `~/.cpanel-mail-mcp/` altına yapılır (npx önbelleği geçici olduğu için
kalıcı bir dizine kopyalanır), ayarlar `~/.cpanel-mail-mcp/.env` dosyasında
`600` izniyle tutulur.

> [!NOTE]
> Kurulum git yerine GitHub'ın `.tar.gz` arşivinden yapılır. npm 12 ve sonrası
> hem `github:` (`EALLOWGIT`) hem de URL'den paket indirmeyi (`EALLOWREMOTE`)
> varsayılan olarak reddeder; `--allow-remote=all` yalnızca bu tek çalıştırma
> için tarball'a izin verir, genel npm ayarını değiştirmez. `sudo` kullanmayın.

### 🧰 Araçlar

| Grup | Araçlar |
|---|---|
| 📥 **Okuma** | `list_folders` · `list_messages` · `search_messages` · `get_message` · `list_attachments` · `save_attachment` |
| ✉️ **Yazma** | `send_message` (ek dosya destekli) · `reply_message` (zincir başlıklarını ve alıntıyı korur, `replyAll` destekler) · `forward_message` (ekleriyle birlikte) · `create_draft` |
| 🗂️ **Düzenleme** | `set_flags` (okundu/yıldız/cevaplandı) · `move_message` · `archive_message` · `mark_spam` · `trash_message` |
| 📁 **Klasörler** | `create_folder` · `rename_folder` · `delete_folder` · `empty_trash` |
| 📅 **Takvim** | `list_calendars` · `list_events` · `create_event` · `update_event` · `delete_event` (yalnızca `CALDAV_URL` ayarlıysa) |

> [!IMPORTANT]
> **Kalıcı silme:** `delete_message` yalnızca `ALLOW_DELETE=true` ise açılır.
> Varsayılan kapalıdır; normal silme `trash_message` ile çöp kutusuna taşır ve
> geri alınabilir. `INBOX` klasörü silinemez.

### 🔒 Tasarım kararı

Sunucu **process başına tek posta kutusu** çalışır. Herkes kendi makinesinde
kendi kimlik bilgisiyle bir örnek çalıştırır; şifre o makineden hiç çıkmaz.

Merkezî bir kurulum bilinçli olarak tercih edilmedi: cPanel'de mail için OAuth
ya da uygulama şifresi yoktur, dolayısıyla merkezî bir sunucu herkesin düz IMAP
şifresini saklamak zorunda kalırdı. O şifre kutuyu okuma **ve o kişi adına mail
gönderme** yetkisinin tamamıdır; tek bir ihlal tüm ekibin yazışmasını açar.

### 🛠️ Geliştirme

```bash
git clone https://github.com/Burak-Kumas/cpanel-mail-mcp.git
cd cpanel-mail-mcp
npm install
npm run build
cp .env.example .env   # kendi değerlerini gir
npm start
```

`build/` depoya dahildir; `npx` ile tarball kurulumunun derleme adımı olmadan
çalışabilmesi için gereklidir. Kaynak değiştirdiğinde `npm run build` çalıştırıp
`build/` çıktısını da commit et.

<details>
<summary><b>📝 Teknik notlar</b></summary>

- Ayarlar sunucunun kendi klasöründeki `.env` dosyasından okunur; gerçek ortam
  değişkenleri verilirse onlar önceliklidir.
- cPanel'in `cpdavd` servisi multistatus yanıtlarında yanlış `href` döndürdüğü
  için CalDAV keşfi elle yapılır (`tsdav`'ın otomatik keşfi bu sunucularda
  "cannot find homeUrl" hatası verir).
- Taslak klasörü IMAP `SPECIAL-USE` bayrağından bulunur; cPanel'de bu klasör
  `Drafts` değil `INBOX.Drafts` şeklindedir.
- Masaüstü uygulaması kullanıcının kabuğunu yüklemez, bu yüzden kayıt sırasında
  `node` yerine mutlak yol kullanılır (nvm bir kabuk fonksiyonudur ve masaüstü
  uygulamasında çözülmez).
- SMTP teslimatı Gönderilenler'e bir şey koymaz; gönderilen mesaj IMAP `APPEND`
  ile oraya ayrıca yazılır. Mesaj bir kez derlenip hem gönderilir hem
  kaydedilir, böylece iki kopyanın `Message-ID`'si aynı olur.
- `raw` ile gönderirken nodemailer alıcıları başlıklardan okumaz; envelope
  `MailComposer.getEnvelope()` ile ayrıca verilir (Bcc'yi de o taşır).
- Mesaj gövdeleri `mailparser` ile çözülür; ham kaynaktan başlık kesmek
  çok parçalı ve base64 kodlu mesajlarda okunaksız çıktı veriyordu.

</details>

<div align="right"><a href="#cpanel-mail-mcp">↑ Başa dön</a></div>
