# cpanel-mail-mcp

cPanel posta kutuları için stdio MCP sunucusu: **IMAP + SMTP + CalDAV**.
Claude Code ve Claude masaüstü uygulamasına doğrudan bağlanır — OAuth shim,
reverse proxy veya sürekli açık bir sunucu gerekmez.

Ekip üyeleri için kurulum talimatı: **[KURULUM.md](KURULUM.md)**

## Kurulum

```bash
npx -y github:Burak-Kumas/cpanel-mail-mcp setup
```

Sihirbaz yalnızca e-posta adresi ve şifre sorar. Sunucu adını, portları ve
takvimin var olup olmadığını kendisi tespit eder; şifreyi kaydetmeden önce
gerçek bir IMAP girişiyle doğrular; ardından hem Claude Code'a hem masaüstü
uygulamasına kaydeder.

Kurulum `~/.cpanel-mail-mcp/` altına yapılır (npx önbelleği geçici olduğu için
kalıcı bir dizine kopyalanır), ayarlar `~/.cpanel-mail-mcp/.env` dosyasında
`600` izniyle tutulur.

## Tasarım kararı

Sunucu **process başına tek posta kutusu** çalışır. Herkes kendi makinesinde
kendi kimlik bilgisiyle bir örnek çalıştırır; şifre o makineden hiç çıkmaz.

Merkezî bir kurulum bilinçli olarak tercih edilmedi: cPanel'de mail için OAuth
ya da uygulama şifresi yoktur, dolayısıyla merkezî bir sunucu herkesin düz IMAP
şifresini saklamak zorunda kalırdı. O şifre kutuyu okuma **ve o kişi adına mail
gönderme** yetkisinin tamamıdır — tek bir ihlal tüm ekibin yazışmasını açar.

## Araçlar

**Mail:** `list_folders`, `list_messages`, `search_messages`, `get_message`,
`send_message`, `create_draft`

**Takvim** (yalnızca `CALDAV_URL` ayarlıysa): `list_calendars`, `list_events`,
`create_event`

**Silme:** `delete_message` yalnızca `ALLOW_DELETE=true` ise açılır (geri
alınamaz, varsayılan kapalı).

## Geliştirme

```bash
git clone https://github.com/Burak-Kumas/cpanel-mail-mcp.git
cd cpanel-mail-mcp
npm install
npm run build
cp .env.example .env   # kendi değerlerini gir
npm start
```

`build/` depoya dahildir; `npx github:...` kurulumunun derleme adımı olmadan
çalışabilmesi için gereklidir. Kaynak değiştirdiğinde `npm run build` çalıştırıp
`build/` çıktısını da commit et.

## Notlar

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
