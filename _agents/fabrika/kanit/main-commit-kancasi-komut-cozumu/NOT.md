# Kanıt kayıtları — hangisi geçerli
- **Geçerli son hal (heredoc yaması sonrası, 23 Eki):** `olcum-kanca-sinavi-v5-sonra` (61/0) · `olcum-kanca-sinavi-codex-sonra` (62/0, codex kopyası) · `olcum-on-bicim-v5-sonra` (10/10, HOME sabitli) · `olcum-bozma-adlari-v8-tek` (17 bozmanın 17'si adıyla yakalandı, pozitif kontrol 61/0).
- `olcum-on-bicim-v4-sonra`: GEÇERSİZ ilan edildi — `~` satırı HOME sabitlemesiz koşuldu (1/10 YANLIŞ), v5 yerine geçti.
- Önceki son hal (tur 3, heredoc öncesi): `olcum-kanca-sinavi-v4-sonra` (53/0) · `olcum-on-bicim-v3-sonra` (10/10) · `olcum-bozma-adlari-v7-tek` (15/15).
- `olcum-bozma-adlari-v5-tek` ve `-v6-tek`: `alt-kabuk-sizar` bozması **eşdeğerdi / yanlış değeri taşıyordu** (S geri yüklemesi bir sonraki listede zaten yeniden kuruluyor; iç sonuç `L.A`'dadır). Yaşadığı görünen bozma kapının değil bozmanın hatasıdır; v7'de gerçek sızıntıyı üretir ve düşer.
- `-tek` / `-v2` … `-v4` bozma kayıtları ve `kanca-sinavi-sonra` … `-v3`: ara turların kodu için geçerliydi, son kodu temsil etmez (göz tur 1 başarısız cd · tur 2 koşullu yürütme).
- `olcum-on-bicim-once` ve `olcum-kanca-sinavi-once`: eski kanca (kurulu 0.35.0 / origin/main) — önce hali.
