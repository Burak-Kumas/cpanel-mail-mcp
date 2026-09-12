# Mail MCP Kurulumu

Posta kutunu Claude'a bağlar. Claude mailini okuyabilir, arayabilir, taslak
hazırlayabilir, senin onayınla gönderebilir ve takvimini görebilir.

**Süre: yaklaşık 2 dakika.** Tek komut çalıştırıp e-posta adresin ile şifreni
gireceksin, başka hiçbir şey yapmana gerek yok.

---

## Önce: Node.js kurulu mu?

Terminal'i aç (Spotlight'ta `Terminal` yaz) ve şunu çalıştır:

```bash
node --version
```

`v20` veya daha büyük bir sayı görüyorsan hazırsın, aşağı geç.

Komut bulunamadı derse: https://nodejs.org adresinden **LTS** sürümünü indirip
kur, sonra Terminal'i kapatıp yeniden aç.

---

## Kurulum

Terminal'e şunu yapıştır ve Enter'a bas:

```bash
npx -y github:Burak-Kumas/cpanel-mail-mcp setup
```

Sana iki şey soracak:

1. **E-posta adresin** — örn. `ad@dantatsu.com`
2. **Posta hesabı şifren** — yazarken ekranda görünmez, bu normaldir

> Bu, cPanel/webmail **giriş** şifren değil, o posta hesabının şifresidir.
> İkisi aynıysa sorun yok.

Sunucu adresini, portları ve takvimi kendisi bulur. Şifreni kaydetmeden önce
gerçekten çalışıp çalışmadığını dener; yanlışsa tekrar sorar.

Bitince **Claude'u tamamen kapatıp yeniden aç.**

---

## Çalıştığını nasıl anlarım?

Claude'a sor:

- "Gelen kutumdaki son 10 maili listele"
- "Ayşe'den gelen mailleri ara"
- "Bu haftaki takvimimi göster"

İlk kullanımda Claude izin isteyecek, onayla.

---

## Neler yapabilir?

| Ne | Açıklama |
|---|---|
| Mail listeleme | Klasörlerdeki son mesajlar |
| Mail arama | Gönderen, konu, tarih veya içerik |
| Mail okuma | Tek bir mesajın tamamı |
| Taslak yazma | Taslaklar'a kaydeder, **göndermez** |
| Mail gönderme | Senin onayınla gönderir |
| Takvim | Etkinlikleri görüntüler ve oluşturur |

Mail **silme** kapalıdır. Claude yanlışlıkla bir mailini silemez.

---

## Sorun giderme

**`npx: command not found`**
Node.js kurulu değil. Yukarıdaki "Önce" bölümüne dön.

**"Giriş başarısız" diyor**
Şifre yanlış. Unutma: cPanel giriş şifren değil, posta hesabının şifresi.
Webmail'e (`https://webmail.alanadiniz.com`) o şifreyle girebiliyorsan doğrudur.

**"Sunucu adını otomatik bulamadım" diyor**
Sana sunucu adını soracak. cPanel > Email Accounts > **Connect Devices**
ekranındaki *Secure SSL/TLS Settings* altındaki Incoming Server adını gir.

**Kurulum bitti ama Claude mailimi görmüyor**
Claude'u tamamen kapatıp yeniden aç (pencereyi kapatmak yetmez; Mac'te
`Cmd+Q`).

**Şifremi değiştirdim**
Aynı kurulum komutunu tekrar çalıştır, yeni şifreyi gir.

Çözemezsen Burak'a yaz.

---

## Güvenlik

Kurulum **senin bilgisayarında** çalışır. Şifren yalnızca kendi makinendeki
`~/.cpanel-mail-mcp/.env` dosyasında, sadece senin okuyabileceğin izinlerle
saklanır. Merkezî bir sunucuya, bize ya da başka birine gönderilmez.
Kimse senin kutuna erişemez, sen de başkasının kutusuna erişemezsin.

Claude mail göndermeden önce her seferinde onayını ister. Alıcıyı ve içeriği
okumadan onaylama.

Şifren bir yerde ifşa olduysa (ekran görüntüsü, sohbet, e-posta) cPanel'den
hemen değiştir ve kurulum komutunu tekrar çalıştır.
