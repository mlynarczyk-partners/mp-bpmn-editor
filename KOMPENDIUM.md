# BPMN Editor — kompendium projektu

Dokument zbiera wszystko, co wypracowaliśmy przy okazji budowy, publikacji i wdrożenia własnego edytora BPMN: adresy, architekturę, workflow pracy z Claude i szczegóły serwera. Traktuj to jako punkt odniesienia na przyszłość — zarówno dla siebie, jak i dla każdego, kto dołączy do projektu.

## 1. Czym jest ten projekt

Samodzielnie zbudowany edytor diagramów BPMN działający w 100% w przeglądarce (bazuje na bibliotece [bpmn-js](https://bpmn.io/)), rozszerzony o funkcje specyficzne dla Młynarczyk & Partners: słowniki tagów (Systems/Locations), rozszerzony widok szczegółów, nawigację po dużych, wielopoziomowych procesach (niezależną od basenów/torów) i wbudowaną instrukcję obsługi w trzech językach.

## 2. Adresy i lokalizacje

| Co | Adres / ścieżka |
|---|---|
| Repozytorium GitHub (publiczne, MIT) | https://github.com/mlynarczyk-partners/mp-bpmn-editor |
| Aplikacja na żywo (aktualna wersja) | https://esnc.kei.pl/MP_BPMN/ |
| Stara wersja (poprzednia, pozostawiona bez zmian) | https://esnc.kei.pl/_/bpmn/ |
| Lokalny folder roboczy na Twoim komputerze | `~/Desktop/BPMN_Editor` |
| Panel hostingu (cyber_folks / WebAs) | https://panel.cyberfolks.pl (albo `cyberadmin.` / `serverpanel.` — zależnie od typu panelu) |

## 3. Co dokładnie robi aplikacja

Edytor diagramów BPMN 2.0 działający w 100% w przeglądarce, zbudowany na bibliotece [bpmn-js](https://bpmn.io/) — bez backendu, bez kroku budowania (build), bez niczego do instalacji. Diagramy są czytane i zapisywane bezpośrednio na dysku użytkownika (File System Access API), bez pośrednictwa serwera.

### Edycja i elementy BPMN

- Pełny zestaw elementów BPMN 2.0 z bpmn-js: zadania (i wszystkie podtypy — User/Service/Manual/Script/Business Rule/Send/Receive Task), zdarzenia, bramki, subprocesy, Call Activities, pule/tory, obiekty danych, grupy, adnotacje tekstowe, przepływy sekwencji/wiadomości i powiązania — z paletą drag-and-drop, context padem, undo/redo i dopasowaniem widoku do zawartości (Fit view).
- Wszystkie kształty typu zadanie (łącznie z Call Activities) są przeskalowywalne ręcznie — domyślnie bpmn-js pozwala na to tylko kontenerom (subprocesy, pule, tory, grupy, adnotacje); to rozszerzenie dodane w tym edytorze. Wpisanie rozmiaru w panelu właściwości ma twardy dolny limit 10×10 px (żeby literówka nie skurczyła kształtu do zera).
- **Zmiana typu elementu zachowuje jego pozycję i rozmiar**, zamiast resetować do domyślnego rozmiaru biblioteki. Dotyczy zamiany między dowolnymi podtypami zadań (np. Task → Service Task) oraz zamiany na/z **zwiniętego** subprocesu — świadomie NIE dotyczy to rozwiniętego subprocesu (bo to kontener, który ma się swobodnie rozciągać, a wymuszanie na nim rozmiaru zadania uczyniłoby go bezużytecznym).
- Konfigurowalny domyślny rozmiar nowo tworzonych zadań (Settings ⚙), stosowany jednolicie do każdego podtypu zadania — obejmuje zarówno przeciąganie z palety, jak i dodawanie przez „+” z context padu (import pliku nigdy tego nie dotyka — istniejące zadania z wczytanego pliku zachowują swój oryginalny rozmiar).

### Obsługa plików

- **New / Open… / Save** — natywny wybór pliku (File System Access API), z fallbackiem do zwykłego pobierania pliku w przeglądarkach, które go nie obsługują.
- Przeciągnięcie pliku `.bpmn` / `.xml` bezpośrednio na płótno też działa jako import.
- **Auto-save** — ciche, opóźnione (debounced) zapisywanie zmian z powrotem do aktualnie otwartego pliku, ale tylko jeśli plik został otwarty lub zapisany przez natywne okno wyboru (nie przez przeciągnięcie).
- Ostatnio otwarty plik jest zapamiętywany (uchwyt pliku w IndexedDB) i po ponownym wejściu na stronę wczytywany po cichu — albo, jeśli przeglądarka wymaga jawnego potwierdzenia dostępu, proponowany jednym kliknięciem w pasku narzędzi („Restore last file?”).
- Przycisk „Close file” (✕) czyści płótno i zapomina zapamiętany plik.

### Struktura procesu i nawigacja

- Panel **Process structure** po prawej (z możliwością zmiany szerokości przeciąganiem) pokazuje główny proces wraz z zagnieżdżonymi subprocesami i Call Activities jako jedno drzewo, z nawigacją jednym kliknięciem.
- Drzewo jest budowane z rzeczywistego elementu `bpmn:Process` (i jego `flowElements`) **niezależnie od tego, czy plik ma basen/tory** (`bpmn:Collaboration`/`bpmn:Participant`/`bpmn:Lane`) czy nie — to czysto wizualna warstwa organizacji, bez wpływu na strukturę „głównego procesu → subprocesy → Call Activities”. Wcześniej appka rozpoznawała tylko goły proces, co przy plikach z basenem dawało błędne „No diagram” — poprawione.
- **Ważne ograniczenie:** subproces trzeba raz ręcznie rozwinąć na płótnie (mała ikonka „+” na zwiniętym kształcie), zanim stanie się klikalny w drzewku — to samo dotyczy okna wyboru celu przy linkowaniu Call Activity (pokazuje tylko subprocesy, które już mają własną „planszę”).
- **Call Activities** — linkowanie zwykłych zadań (Task/User Task/Service Task/Manual Task — nie Script/Business Rule/Send/Receive Task) do dowolnego subprocesu w tym samym pliku, z podglądem celu w drzewku i panelu właściwości, szybkim przejściem („Go to target ↗”) i możliwością usunięcia linku z powrotem do zwykłego Task („Remove link”) — to działanie jest jednokierunkowe, link trzeba by tworzyć od nowa.
- **Breadcrumb** — ścieżka nawigacyjna nad płótnem, widoczna gdy tylko wejdziesz poniżej głównego procesu: przycisk „↑ Back to: …” plus pełna klikalna ścieżka wstecz. Każdy poziom pamięta własne przesunięcie i przybliżenie (pan/zoom), więc powrót do wcześniej odwiedzonego poziomu przywraca dokładnie ten sam widok zamiast dopasowywać go od nowa.

### Panel właściwości elementu

- Nazwa, typ, kolor wypełnienia (dla kształtów, które go obsługują), edytowalny rozmiar (patrz wyżej) i dwa pola tekstowe — **Description** i **Details** — zapisywane automatycznie w momencie opuszczenia pola (bez osobnego przycisku zapisu).
- Tagi **System** i **Location**, wybierane ze zdefiniowanych w Ustawieniach słowników (patrz niżej), z opcjonalnym trybem „Extended details”, który nakłada kolorowe plakietki i ikonę linku wprost na płótno.
- Jeśli pole **Details** zawiera adres URL, na kształcie pojawia się mała klikalna ikona linku.
- Panel jest zwijalny, a jego stan (zwinięty/rozwinięty) jest zapamiętywany między sesjami (localStorage).

### Ustawienia i słowniki (Systems & Locations)

- W panelu Settings (⚙) zarządza się dwiema wielokrotnego użytku listami tagów — **Systems** i **Locations** — każdy to po prostu nazwa i kolor.
- Słowniki są zapisywane lokalnie na komputerze **i** wbudowywane bezpośrednio w sam plik `.bpmn` przy zapisie, więc podróżują razem z plikiem — otwarcie go na innym komputerze przynosi te same tagi.
- Tam samo ustawia się domyślny rozmiar nowo tworzonych zadań (patrz wyżej).

### Personalizacja wizualna

- Wyselekcjonowana paleta kolorów plus możliwość wyboru dowolnego koloru niestandardowego, dla każdego kolorowalnego kształtu (zadania, zdarzenia, bramki, grupy, adnotacje tekstowe, …).
- **Grupy i adnotacje tekstowe**, które bpmn-js domyślnie renderuje bez żadnego wypełnienia, dostały własne, dodane w tym edytorze tło: grupy w półprzezroczystym odcieniu wybranego koloru (żeby nadal było widać, co jest pod spodem — grupa ma tylko wizualnie skupiać elementy, a nie je zasłaniać), a adnotacje tekstowe w pełnym kolorze z automatyczną korektą koloru tekstu (czarny/biały, w zależności od jasności tła), tak by zawsze zachować czytelny kontrast.
- Pule i tory renderowane są w pełni przezroczyste, żeby siatka na płótnie zawsze była widoczna.
- Przełącznik siatki (#) cyklicznie zmienia tło: wyłączona → 10px → 50px — to czysto wizualna podpowiedź, nie wpływa na przyciąganie kształtów do siatki.

### Panel XML

- Podgląd surowego XML diagramu, ręczna edycja, przycisk „Import changes” do zastosowania zmian z powrotem w diagramie, oraz „Copy XML” do skopiowania do schowka.

### Skróty klawiszowe

- **Ctrl/Cmd + S** — zapisz, **Ctrl/Cmd + O** — otwórz, **Ctrl/Cmd + Z** — cofnij, **Ctrl/Cmd + Shift + Z** (albo **Ctrl/Cmd + Y**) — ponów, **Escape** — wyjdź o jeden poziom wyżej z subprocesu.

### Wbudowana instrukcja obsługi

- Przycisk „?” przypięty na stałe do dołu lewego paska narzędzi otwiera pełny, szczegółowy przewodnik po wszystkich powyższych funkcjach (łącznie z niuansami typu „kiedy subproces jest klikalny”), dostępny w trzech językach — EN/PL/RU — z zapamiętywanym wyborem języka.
- Przy pierwszym uruchomieniu aplikacji dodatkowo pojawia się dymek „How does it work?” z przyciemnionym tłem i strzałką wskazującą na przycisk „?” — znika po kliknięciu i nie pojawia się ponownie (localStorage).

### Wsparcie przeglądarek

- Otwieranie, zapisywanie i auto-zapis opierają się na File System Access API, obecnie dostępnym w przeglądarkach opartych na Chromium (Chrome, Edge, Brave, Arc, Opera). W innych przeglądarkach edytor nadal działa, ale zapis odbywa się przez zwykłe pobranie pliku zamiast nadpisania oryginału.

## 4. Struktura plików w repozytorium

```
BPMN_Editor/
├── index.htm                     — główny plik HTML
├── assets/
│   ├── css/app.css                — style
│   ├── js/app.js                  — logika aplikacji
│   ├── js/help-content.js         — treść instrukcji obsługi (EN/PL/RU)
│   ├── img/                       — logo M&P (wersja toolbar + wersja na płótno)
│   ├── font/                      — czcionka ikon BPMN
│   └── vendor/                    — biblioteka bpmn-js
├── README.md
├── LICENSE (MIT)
└── .gitignore
```

Wszystkie komentarze w kodzie i widoczne teksty UI są w języku angielskim.

## 5. Workflow pracy: „Git + AI”

Ustaliliśmy trzyetapowy proces, który obowiązuje przy każdej kolejnej zmianie:

1. **Edycja i weryfikacja z Claude** — zmiany powstają w chmurowym środowisku Claude, są testowane (Playwright, sprawdzanie składni, zrzuty ekranu) w izolowanej kopii, a dopiero potem dostarczane 1:1 (ze sprawdzeniem sumy md5) do `~/Desktop/BPMN_Editor` na Twoim komputerze.
2. **Commit i push na GitHub — tylko na Twoje hasło „GIT GO”.** Do tego momentu Claude nie pokazuje komend git ani nic nie commituje. Po „GIT GO” dostajesz gotowe komendy `git add / commit / push` do wklejenia we własnym terminalu (Claude nigdy nie wykonuje ich sam — komunikacja z serwerem Twojego komputera nie pozwala na operacje gita ze względu na blokadę `unlink()` w zamontowanym folderze).
3. **Deploy na serwer esnc** — jedna komenda w Twoim terminalu:
   ```bash
   ~/Desktop/BPMN_Editor/deploy_esnc.expect
   ```
   Wgrywa `index.htm` i cały folder `assets/` na serwer, automatycznie, bez ręcznego podawania hasła.

## 6. Serwer esnc.kei.pl — szczegóły techniczne

- **Hosting:** cyber_folks, panel typu **WebAs**, konto `esnc` (62 domeny na jednym koncie).
- **Dostęp:** SSH (zwykła powłoka) jest **zablokowany** dla tego konta — to celowe ustawienie w panelu (Konfiguracja → Bezpieczeństwo → Dostęp do FTP/SSH). Transfer plików przez **SFTP/SCP jest aktywny** i to jedyny sposób wgrywania plików.
- **Dane połączenia:** host `94.152.10.79`, port `22`, użytkownik `esnc`.
- **Brak chroota** — prawdziwa ścieżka na serwerze to `/home/users/esnc/...`; ścieżki względne (bez `/` na początku) działają poprawnie, bezwzględne (`/public_html/...`) — nie, bo `/public_html` nie istnieje w prawdziwym korzeniu systemu plików.
- **Katalog docelowy aplikacji:** `public_html/MP_BPMN/` (czyli pełna ścieżka `/home/users/esnc/public_html/MP_BPMN/`), odpowiada adresowi `https://esnc.kei.pl/MP_BPMN/`.
- **Brak obsługi kluczy SSH** w tym panelu — logowanie tylko hasłem, dlatego automatyzacja (patrz niżej) korzysta z macOS Keychain, nie z kluczy.
- **Panel logowania bywa blokowany geograficznie** dla ruchu spoza Polski (potwierdzone w dokumentacji cyber_folks dla innych usług, np. SMTP) — jeśli logowanie do panelu nie działa za granicą, pomaga VPN z węzłem w Polsce.

## 7. Automatyzacja deployu — jak to działa

Dwa pliki pomocnicze leżą **lokalnie** w `~/Desktop/BPMN_Editor` (celowo dodane do `.gitignore` — nie trafiają do publicznego repo, bo ujawniają adres IP i strukturę katalogów serwera):

- **`deploy_esnc.sftp`** — lista komend SFTP (cd/lcd/put -r) używana jako referencja/wsad.
- **`deploy_esnc.expect`** — właściwy, w pełni automatyczny skrypt uruchamiany komendą `./deploy_esnc.expect`. Robi trzy rzeczy:
  1. Pobiera hasło z macOS Keychain (`security find-generic-password -a esnc -s esnc-mp-bpmn-sftp -w`) — hasło nigdy nie trafia do Claude ani nie jest zapisane w żadnym pliku.
  2. Loguje się przez `sftp`, symulując wpisanie hasła i kolejnych komend (bo tryb wsadowy `-b` w sftp wymusza logowanie kluczem i nie pozwala na hasło — dlatego użyto `expect`, a nie samego `sftp -b`).
  3. Wgrywa `index.htm` i `assets/` do `public_html/MP_BPMN/`.

**Jednorazowy setup** (już wykonany, ale warto zapisać na wypadek zmiany hasła w przyszłości):
```bash
echo -n "Hasło esnc: "; read -s PW; echo
security add-generic-password -a esnc -s esnc-mp-bpmn-sftp -w "$PW" -U
unset PW
```
Flaga `-U` nadpisuje istniejący wpis, więc tej samej komendy użyjesz, gdy zmienisz hasło do konta esnc.

## 8. Rzeczy do ewentualnego dosprzątania

- Na serwerze, w `public_html/`, zostały dwa literówkowe, puste foldery z wcześniejszych prób (`MP_BPMB`, `PM_PBPN`) — nie zostało ostatecznie potwierdzone, czy zostały usunięte (`rmdir MP_BPMB` / `rmdir PM_PBPN` przez sesję `sftp`). Warto to sprawdzić i posprzątać, jeśli jeszcze tam są.
- Plik `.DS_Store` (nieszkodliwe metadane macOS Finder) wgrywa się razem z `assets/` przy każdym deployu — kosmetyczny drobiazg, do ewentualnego wykluczenia ze skryptu w przyszłości.

## 9. Zasady współpracy z Claude w tym projekcie

- Zmiany w kodzie: zawsze najpierw zweryfikowane (headless Playwright, sprawdzenie składni, zrzuty ekranu), potem dostarczone z potwierdzeniem sumy md5.
- Żadne polecenia `git` nie są pokazywane ani wykonywane, dopóki nie padnie hasło **„GIT GO”**.
- Claude nigdy nie wpisuje, nie przechowuje ani nie obsługuje haseł/kluczy/danych logowania — nawet jeśli użytkownik je oferuje. Automatyzacja (jak wyżej) zawsze opiera się na mechanizmach po stronie użytkownika (Keychain), nigdy na przekazywaniu sekretów do Claude.
- Operacje na serwerze/gita zawsze wykonuje użytkownik we własnym terminalu — Claude przygotowuje pliki i komendy, ale nie ma sieciowego dostępu do zewnętrznych serwerów ani nie wykonuje operacji wymagających poświadczeń.
