# Kanıt kayıtları — hangisi geçerli
- **Geçerli son hal:** `olcum-kanca-sinavi-v4-sonra` (53/0) · `olcum-on-bicim-v3-sonra` (10/10) · `olcum-bozma-adlari-v7-tek` (15 bozmanın 15'i adıyla yakalandı, pozitif kontrol 53/0).
- `olcum-bozma-adlari-v5-tek` ve `-v6-tek`: `alt-kabuk-sizar` bozması **eşdeğerdi / yanlış değeri taşıyordu** (S geri yüklemesi bir sonraki listede zaten yeniden kuruluyor; iç sonuç `L.A`'dadır). Yaşadığı görünen bozma kapının değil bozmanın hatasıdır; v7'de gerçek sızıntıyı üretir ve düşer.
- `-tek` / `-v2` … `-v4` bozma kayıtları ve `kanca-sinavi-sonra` … `-v3`: ara turların kodu için geçerliydi, son kodu temsil etmez (göz tur 1 başarısız cd · tur 2 koşullu yürütme).
- `olcum-on-bicim-once` ve `olcum-kanca-sinavi-once`: eski kanca (kurulu 0.35.0 / origin/main) — önce hali.
