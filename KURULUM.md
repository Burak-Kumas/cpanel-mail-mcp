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
npx -y https://github.com/Burak-Kumas/cpanel-mail-mcp/archive/refs/heads/main.tar.gz setup
```

cPanel posta hesabının bilgilerini soracak:

1. **Kullanıcı adı**: tam e-posta adresin, örn. `ad@firma.com`
2. **Şifre**: yazarken ekranda görünmez, bu normaldir
3. **Sunucu (host)**: varsayılan `mail.alanadiniz.com`
4. **IMAP portu**: varsayılan `993`
5. **SMTP portu**: varsayılan `465`

Hepsi cPanel > Email Accounts > **Connect Devices** ekranındaki
*Secure SSL/TLS Settings* bölümünde yazar. Köşeli parantez içinde gösterilen
değer doğruysa Enter'a basman yeterli.

> Şifre, cPanel/webmail **giriş** şifren değil, o posta hesabının şifresidir.
> İkisi aynıysa sorun yok.

Kaydetmeden önce IMAP ve SMTP girişini gerçekten dener; yanlışsa bilgileri
tekrar sorar. Takvimi kendisi bulur.

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
| Listeleme & arama | Klasörlerdeki mesajlar; gönderen, konu, tarih veya içerik araması |
| Okuma | Mesajın tamamı, ekleriyle birlikte |
| Gönderme | Senin onayınla gönderir, dosya ekleyebilir |
| Cevaplama | Konu zincirini bozmadan cevaplar, "tümünü yanıtla" destekler |
| İletme | Ekleriyle birlikte iletir |
| Taslak | Taslaklar'a kaydeder, **göndermez** |
| Ekler | Ekleri listeler ve bilgisayarına kaydeder |
| Düzenleme | Okundu/okunmadı, yıldızlama, arşivleme, spam'e taşıma |
| Silme | Çöp kutusuna taşır (geri alınabilir) |
| Klasörler | Oluşturur, yeniden adlandırır, siler |
| Takvim | Etkinlikleri görüntüler, oluşturur, günceller, siler |

**Güvenlik sınırları:** Silme işlemi maili çöp kutusuna taşır — geri alabilirsin.
Kalıcı silme varsayılan olarak **kapalıdır**, Claude yanlışlıkla bir maili
geri dönülmez şekilde silemez. Gelen kutusu klasörü de silinemez.

---

## Sorun giderme

**`npx: command not found`**
Node.js kurulu değil. Yukarıdaki "Önce" bölümüne dön.

**"Giriş başarısız" diyor**
Şifre yanlış. Unutma: cPanel giriş şifren değil, posta hesabının şifresi.
Webmail'e (`https://webmail.alanadiniz.com`) o şifreyle girebiliyorsan doğrudur.

**Sunucu adını ya da portu bilmiyorum**
cPanel > Email Accounts > **Connect Devices** ekranındaki *Secure SSL/TLS
Settings* bölümüne bak: Incoming Server (IMAP, 993) ve Outgoing Server
(SMTP, 465) orada yazar.

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
