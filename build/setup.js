/**
 * Interactive installer: `cpanel-mail-mcp setup`
 *
 * Goal is a one-command install for non-technical teammates. It:
 *   1. asks for the mailbox address and password (password never echoed),
 *   2. guesses IMAP/SMTP hosts from the domain and verifies them over TLS,
 *   3. proves the credentials work with a real IMAP login BEFORE saving,
 *   4. copies the server to a permanent directory (npx's cache is temporary,
 *      and the MCP registration must keep working after it is cleared),
 *   5. registers it with both Claude Code and the Claude desktop app.
 *
 * The password is written only to ~/.cpanel-mail-mcp/.env with mode 600. It is
 * never passed on a command line (it would land in shell history and `ps`).
 */
import { spawnSync } from "node:child_process";
import { connect as tlsConnect } from "node:tls";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline";
import { Writable } from "node:stream";
import { ImapFlow } from "imapflow";
const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL_DIR = join(homedir(), ".cpanel-mail-mcp");
const ENV_PATH = join(INSTALL_DIR, ".env");
const SERVER_PATH = join(INSTALL_DIR, "build", "index.js");
// ---------- prompts ----------
// readline echoes keystrokes to its output stream. Rather than fight it for the
// password prompt, we hand it an output stream we can mute: while muted the
// typed characters are dropped instead of reaching the terminal.
class MutableOutput extends Writable {
    muted = false;
    _write(chunk, enc, cb) {
        if (!this.muted)
            process.stdout.write(chunk, enc);
        cb();
    }
}
const output = new MutableOutput();
const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
function ask(q, def) {
    const suffix = def ? ` [${def}]` : "";
    return new Promise((res) => rl.question(`${q}${suffix}: `, (a) => res(a.trim() || def || "")));
}
function askHidden(q) {
    return new Promise((res) => {
        process.stdout.write(`${q}: `);
        output.muted = true;
        rl.question("", (a) => {
            output.muted = false;
            process.stdout.write("\n");
            res(a);
        });
    });
}
async function askYesNo(q, def = true) {
    const a = (await ask(`${q} (e/h)`, def ? "e" : "h")).toLowerCase();
    return a.startsWith("e") || a.startsWith("y");
}
// ---------- checks ----------
function tlsReachable(host, port, timeout = 7000) {
    return new Promise((res) => {
        const sock = tlsConnect({ host, port, servername: host, rejectUnauthorized: false }, () => {
            sock.end();
            res(true);
        });
        sock.setTimeout(timeout, () => {
            sock.destroy();
            res(false);
        });
        sock.on("error", () => res(false));
    });
}
async function imapLoginWorks(host, port, user, pass) {
    const client = new ImapFlow({
        host,
        port,
        secure: true,
        auth: { user, pass },
        logger: false,
    });
    try {
        await client.connect();
        await client.logout().catch(() => { });
        return null;
    }
    catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
}
// ---------- Claude registration ----------
function desktopConfigPath() {
    const home = homedir();
    if (platform() === "darwin")
        return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    if (platform() === "win32")
        return process.env.APPDATA
            ? join(process.env.APPDATA, "Claude", "claude_desktop_config.json")
            : null;
    return join(home, ".config", "Claude", "claude_desktop_config.json");
}
// The desktop app launches servers without the user's shell, so a bare "node"
// (or an nvm shim, which is only a shell function) will not resolve. Prefer a
// node that exists at a fixed path and outlives an nvm version switch.
function stableNodePath() {
    const candidates = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ].filter((p) => existsSync(p));
    for (const c of candidates) {
        const r = spawnSync(c, ["--version"], { encoding: "utf8" });
        const major = Number((r.stdout ?? "").trim().replace(/^v/, "").split(".")[0]);
        if (major >= 20)
            return c;
    }
    return process.execPath;
}
function registerDesktop(nodePath) {
    const p = desktopConfigPath();
    if (!p)
        return "Masaüstü uygulaması yapılandırması bulunamadı, atlandı.";
    try {
        let cfg = {};
        if (existsSync(p)) {
            writeFileSync(`${p}.bak`, readFileSync(p));
            try {
                cfg = JSON.parse(readFileSync(p, "utf8"));
            }
            catch {
                return `${p} okunamadı (geçersiz JSON). Masaüstü kaydı atlandı.`;
            }
        }
        else {
            mkdirSync(dirname(p), { recursive: true });
        }
        cfg.mcpServers = cfg.mcpServers ?? {};
        cfg.mcpServers.mail = { command: nodePath, args: [SERVER_PATH] };
        writeFileSync(p, JSON.stringify(cfg, null, 2));
        return "Claude masaüstü uygulamasına eklendi.";
    }
    catch (e) {
        return `Masaüstü kaydı yapılamadı: ${e instanceof Error ? e.message : e}`;
    }
}
function registerClaudeCode(nodePath) {
    const probe = spawnSync("claude", ["--version"], { encoding: "utf8" });
    if (probe.error)
        return "Claude Code CLI bulunamadı, atlandı.";
    spawnSync("claude", ["mcp", "remove", "mail", "-s", "user"], { encoding: "utf8" });
    const r = spawnSync("claude", ["mcp", "add", "mail", "--scope", "user", "--", nodePath, SERVER_PATH], { encoding: "utf8" });
    return r.status === 0
        ? "Claude Code'a eklendi."
        : `Claude Code'a eklenemedi: ${(r.stderr || r.stdout || "").trim()}`;
}
// ---------- main ----------
export async function runSetup() {
    console.log("\n  cpanel-mail-mcp kurulumu\n  " + "-".repeat(26) + "\n");
    if (existsSync(ENV_PATH)) {
        const overwrite = await askYesNo("Mevcut bir kurulum var. Ayarları yeniden girmek istiyor musun?", false);
        if (!overwrite) {
            console.log("\nAyarlar korundu. Kayıtlar yenileniyor...\n");
            const nodePath = stableNodePath();
            console.log("  " + registerClaudeCode(nodePath));
            console.log("  " + registerDesktop(nodePath));
            rl.close();
            return;
        }
    }
    const email = await ask("E-posta adresin (örn. ad@firma.com)");
    if (!email.includes("@")) {
        console.log("\nGeçerli bir e-posta adresi gerekiyor. Kurulum durduruldu.");
        rl.close();
        process.exit(1);
    }
    const domain = email.split("@")[1];
    // Standard cPanel SSL ports. Only worth asking about if the probe below
    // cannot reach the server at all.
    const imapPort = 993;
    const smtpPort = 465;
    // cPanel answers on mail.<domain> in practice, so detect it instead of
    // sending people into the "Connect Devices" screen.
    let host = `mail.${domain}`;
    process.stdout.write(`\n  Sunucu aranıyor (${host})... `);
    let guessOk = await tlsReachable(host, imapPort);
    console.log(guessOk ? "bulundu." : "yanıt vermedi.");
    if (!guessOk) {
        console.log("\n  Sunucu adını otomatik bulamadım.\n" +
            "  cPanel > Email Accounts > Connect Devices ekranındaki\n" +
            "  'Secure SSL/TLS Settings' sunucu adını gir.\n");
        host = await ask("IMAP/SMTP sunucusu", host);
    }
    let pass = "";
    for (let attempt = 1;; attempt++) {
        pass = await askHidden("Posta hesabı şifresi (ekranda görünmez)");
        process.stdout.write("  Giriş deneniyor... ");
        const err = await imapLoginWorks(host, imapPort, email, pass);
        if (!err) {
            console.log("başarılı.\n");
            break;
        }
        console.log("başarısız.");
        console.log(`  Sunucu yanıtı: ${err}`);
        console.log("  Not: Bu, cPanel giriş şifren değil, o posta hesabının şifresidir.\n");
        if (attempt >= 3) {
            console.log("Üç deneme başarısız oldu. Kurulum durduruldu.");
            rl.close();
            process.exit(1);
        }
    }
    // Calendar is a bonus, not a decision to put in front of the user: enable it
    // when cPanel's CalDAV port answers, stay silent when it does not.
    process.stdout.write("  Takvim aranıyor... ");
    const calOk = await tlsReachable(host, 2080);
    console.log(calOk ? "bulundu, takvim araçları açılıyor." : "yok, sadece mail kurulacak.");
    const caldavUrl = calOk ? `https://${host}:2080/calendars/${email}/calendar` : "";
    // Install to a fixed path: npx runs from a cache that gets cleared, which
    // would break the registration we are about to write.
    mkdirSync(INSTALL_DIR, { recursive: true });
    cpSync(join(PKG_DIR, "build"), join(INSTALL_DIR, "build"), { recursive: true });
    cpSync(join(PKG_DIR, "package.json"), join(INSTALL_DIR, "package.json"));
    if (existsSync(join(PKG_DIR, "node_modules"))) {
        cpSync(join(PKG_DIR, "node_modules"), join(INSTALL_DIR, "node_modules"), {
            recursive: true,
        });
    }
    else {
        console.log("  Bağımlılıklar kuruluyor...");
        spawnSync("npm", ["install", "--omit=dev", "--silent"], {
            cwd: INSTALL_DIR,
            stdio: "inherit",
        });
    }
    const env = `# ${email} — otomatik oluşturuldu. Gizli dosya: paylaşma, git'e ekleme.\n` +
        `IMAP_HOST=${host}\nIMAP_PORT=${imapPort}\nIMAP_TLS=true\n` +
        `SMTP_HOST=${host}\nSMTP_PORT=${smtpPort}\nSMTP_TLS=true\n` +
        `MAIL_USER=${email}\nMAIL_PASS=${pass}\nMAIL_FROM=${email}\n` +
        (caldavUrl ? `CALDAV_URL=${caldavUrl}\n` : "") +
        `\n# Silme aracı kapalı. Açmak için: ALLOW_DELETE=true (geri alınamaz)\n`;
    writeFileSync(ENV_PATH, env, { mode: 0o600 });
    chmodSync(ENV_PATH, 0o600);
    const nodePath = stableNodePath();
    console.log("\n  " + registerClaudeCode(nodePath));
    console.log("  " + registerDesktop(nodePath));
    console.log(`\n  Kurulum tamam.\n\n` +
        `  Ayarlar: ${ENV_PATH}\n` +
        `  Açık olan Claude Code / Claude uygulamasını kapatıp yeniden aç.\n` +
        `  Sonra dene: "Gelen kutumdaki son 10 maili listele"\n`);
    rl.close();
}
