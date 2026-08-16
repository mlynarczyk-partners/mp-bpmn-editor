/* ─── HELP / USER GUIDE CONTENT (EN / PL / RU) ───
   Static HTML strings injected into the Help dialog (see openHelp() in
   app.js). Kept in their own file so app.js doesn't balloon with prose,
   and so a future language/copy edit doesn't touch application logic. */
const HELP_CONTENT = {
  en: `<h3>Getting started</h3>
<p>This editor runs entirely in your browser — there's nothing to install and no server involved. Diagrams are read from and saved directly to your computer's disk.</p>
<ul>
<li><b>New</b> starts a blank diagram.</li>
<li><b>Open…</b> lets you pick a <code>.bpmn</code> or <code>.xml</code> file from disk. You can also just drag a file onto the canvas.</li>
<li><b>Save .bpmn</b> writes the diagram to disk under the name typed in the field next to it.</li>
</ul>

<h3>Auto-save &amp; reopening your last file</h3>
<p>Once you've opened or saved a file through the picker (not by drag-and-drop), the <b>Auto-save</b> toggle keeps writing your changes back to that same file a couple of seconds after you stop editing — no more manually re-saving after every change.</p>
<p>The editor also remembers the last file you had open. Next time you load the page, it's silently reopened for you. If your browser needs you to explicitly confirm access again, you'll see a small "Restore last file?" prompt in the toolbar instead of it opening automatically.</p>

<h3>The Process structure panel</h3>
<p>The panel on the right lists everything in your diagram as one tree: the main process at the top (◈, showing the current file name), every <b>sub-process</b> nested inside it (⊕, indented to match its depth), and every <b>Call Activity</b> (⇒, with its linked target shown underneath). Click any row to jump straight to that part of the diagram — no scrolling or zooming needed to find it.</p>
<p><b>Only sub-processes you've expanded at least once are enterable.</b> bpmn-js only creates a separate "plane" (its own mini-diagram) for a sub-process the first time it's expanded on the canvas (the small <b>+</b> icon on a collapsed sub-process shape). A sub-process still appears in the tree before that — but clicking it does nothing beyond a "No plane for this subprocess (might be collapsed?)" message in the status bar. If that happens, find the collapsed shape on the canvas and expand it once; from then on it works normally in the tree.</p>
<p>Selecting a sub-process shape also adds an <b>"Enter subprocess ↗"</b> button to its properties panel — a shortcut equivalent to clicking it in the tree.</p>

<h3>Call Activities: linking sub-processes together</h3>
<p>A Call Activity is a task-like shape that stands in for "run this other sub-process here" — it's how a large process gets split into linked pieces instead of one giant nested diagram. In the tree, each Call Activity shows its target underneath its name (e.g. "→ Approve invoice"), or <b>"— not set"</b> if it isn't linked yet. Clicking a linked one (in the tree, or via its ↗ icon on the shape) jumps straight into the sub-process it points to; clicking an unlinked one just shows "Call Activity has no target set".</p>
<p>To turn an existing shape into a Call Activity: select a plain <b>Task, User Task, Service Task, or Manual Task</b> — this option isn't offered for Script Task, Business Rule Task, Send Task or Receive Task — and click <b>"Mark as Call Activity ⇒"</b> in its properties panel. A picker opens immediately so you can choose the target sub-process.</p>
<p><b>The picker only lists sub-processes that already have a plane</b> — the same expand-at-least-once rule as above. If you haven't expanded any sub-process in this file yet, the picker says "No subprocesses in this file", even though sub-process shapes exist on the canvas. Expand the one you want to link to first, then come back and link the Call Activity to it.</p>
<p>A linked Call Activity's properties panel also shows <b>"Change target…"</b> (re-open the picker), <b>"Go to target ↗"</b> (jump there directly), and <b>"Remove link (→ Task)"</b> — which turns it back into a plain Task and discards the link. That's a one-way conversion: to relink it you'd mark it as a Call Activity again and pick a target from scratch.</p>

<h3>Breadcrumb &amp; keeping your place</h3>
<p>The moment you're anywhere below the main process, a breadcrumb trail appears above the canvas: an <b>"↑ Back to: …"</b> button for the level directly above, plus the full path back to the main process — click any earlier step to jump straight there, no need to go back one level at a time. Pressing <b>Escape</b> does the same as "Back to": one level up.</p>
<p>Every level remembers its own pan and zoom. Drill three levels deep, look around, then come back up — each level you pass through reopens exactly where you left it, instead of re-fitting the whole diagram.</p>

<h3>Element properties</h3>
<p>Select any shape to see its properties on the right: name, type, a color (for shapes that support one), and two free-text fields — <b>Description</b> and <b>Details</b>. Everything saves the moment you click away from a field (on blur) — there's no separate save step.</p>
<p>An editable width/height only shows up for shapes bpmn-js allows resizing: containers (expanded sub-processes, pools, lanes, groups, text annotations) plus, as an addition in this editor, plain Tasks and every task subtype including Call Activities. Typing a size directly skips the usual drag-to-resize interaction, so there's a hard floor of 10&times;10&nbsp;px to stop a typo from shrinking a shape down to nothing.</p>
<p>If <b>Details</b> holds a web address, a small link icon appears on the shape (see "Extended details view" below) so anyone opening the diagram can jump straight to that page.</p>

<h3>Systems &amp; Locations (tags)</h3>
<p>Open <b>Settings</b> (the ⚙ button) to manage two reusable tag lists: <b>Systems</b> and <b>Locations</b>, each just a name and a color. Once defined, any element's properties panel lets you pick a System and/or a Location from a dropdown instead of typing it out by hand every time.</p>
<p>These lists are stored on this computer and are also embedded into the <code>.bpmn</code> file itself when you save, so they travel with the file — open it on another computer and the same tags come with it.</p>
<p>The same Settings panel also lets you set a <b>default size for newly created tasks</b>, applied automatically to every task subtype (User Task, Service Task, …) as you drag them onto the canvas.</p>

<h3>Extended details view</h3>
<p>The <b>Extended</b> toggle in the toolbar overlays extra information directly on the canvas: elements with a System tag get a colored badge underneath them, elements with a Location tag get one above them, and elements with a Details link get a small ↗ icon you can click straight from the diagram. It's off by default to keep the canvas clean — switch it on when you need an at-a-glance overview.</p>

<h3>Visual options</h3>
<ul>
<li>Every colorable shape (tasks, events, gateways, groups, text annotations, …) has a color picker in its properties panel, with a curated palette plus the option to pick any custom color.</li>
<li>Pools and lanes are rendered fully transparent so the canvas grid shows through cleanly.</li>
<li>The grid toggle (<b>#</b> button) cycles the background grid off → 10px → 50px. It's a purely visual guide — it doesn't change how shapes snap into place.</li>
</ul>

<h3>XML panel</h3>
<p>The <b>XML</b> button opens a side panel with the raw underlying XML of your diagram. You can inspect it, hand-edit it, click <b>Import changes</b> to apply your edits back to the diagram, or <b>Copy XML</b> to the clipboard.</p>

<h3>Convert to M&amp;P BPMN</h3>
<p>Files created in other tools sometimes wrap the whole process in a "collaboration" with a single pool, which this editor's Process structure panel doesn't recognize — you'll see "No diagram" instead of your process tree. When that's safe to fix (exactly one pool, no message flows — i.e. nothing would be discarded), a <b>Convert to M&amp;P BPMN</b> button appears so you can flatten the file to a plain process with one click. If converting could discard anything, the button simply doesn't appear.</p>

<h3>Keyboard shortcuts</h3>
<ul>
<li><b>Ctrl/Cmd + S</b> — Save</li>
<li><b>Ctrl/Cmd + O</b> — Open…</li>
<li><b>Ctrl/Cmd + Z</b> — Undo</li>
<li><b>Ctrl/Cmd + Shift + Z</b> (or <b>Ctrl/Cmd + Y</b>) — Redo</li>
</ul>

<h3>Browser support</h3>
<p>Opening, saving and auto-save all rely on the File System Access API, currently available in Chromium-based browsers (Chrome, Edge, Brave, Arc, Opera). In other browsers the editor still works, but saving falls back to a plain file download instead of writing back to the original file.</p>
`,
  pl: `<h3>Pierwsze kroki</h3>
<p>Ten edytor działa całkowicie w przeglądarce — nie ma nic do zainstalowania i nie korzysta z żadnego serwera. Diagramy są wczytywane i zapisywane bezpośrednio na dysku Twojego komputera.</p>
<ul>
<li><b>New</b> tworzy pusty diagram.</li>
<li><b>Open…</b> pozwala wybrać plik <code>.bpmn</code> lub <code>.xml</code> z dysku. Możesz też po prostu przeciągnąć plik na płótno.</li>
<li><b>Save .bpmn</b> zapisuje diagram na dysku pod nazwą wpisaną w polu obok.</li>
</ul>

<h3>Auto-zapis i wznawianie ostatniego pliku</h3>
<p>Gdy raz otworzysz lub zapiszesz plik przez systemowe okno wyboru (nie przez przeciągnięcie), przełącznik <b>Auto-save</b> zapisuje kolejne zmiany do tego samego pliku kilka sekund po zakończeniu edycji — koniec z ręcznym zapisywaniem po każdej zmianie.</p>
<p>Edytor pamięta też ostatnio otwarty plik. Przy następnym wejściu na stronę zostaje on wczytany po cichu, sam. Jeśli przeglądarka wymaga jawnego potwierdzenia dostępu, zamiast automatycznego wczytania zobaczysz w pasku narzędzi krótkie pytanie „Restore last file?".</p>

<h3>Panel Process structure</h3>
<p>Panel po prawej pokazuje całą zawartość diagramu jako jedno drzewo: główny proces na górze (◈, z nazwą aktualnego pliku), każdy zagnieżdżony <b>subproces</b> (⊕, z wcięciem odpowiadającym głębokości) oraz każdą <b>Call Activity</b> (⇒, z powiązanym celem pokazanym pod nazwą). Kliknięcie dowolnej pozycji przenosi od razu do tej części diagramu — bez przewijania i szukania.</p>
<p><b>Wejść można tylko w subprocesy, które choć raz zostały rozwinięte.</b> bpmn-js tworzy osobną "planszę" (własny mini-diagram) dla subprocesu dopiero przy pierwszym rozwinięciu go na płótnie (mała ikonka <b>+</b> na zwiniętym kształcie subprocesu). Subproces pojawia się w drzewie już wcześniej — ale kliknięcie go nic nie robi poza komunikatem "No plane for this subprocess (might be collapsed?)" w pasku statusu. Jeśli tak się stanie, znajdź zwinięty kształt na płótnie i rozwiń go raz; od tej pory będzie działał normalnie w drzewie.</p>
<p>Zaznaczenie kształtu subprocesu dodaje też przycisk <b>"Enter subprocess ↗"</b> w jego panelu właściwości — skrót równoważny kliknięciu w drzewie.</p>

<h3>Call Activities: łączenie subprocesów</h3>
<p>Call Activity to kształt przypominający zadanie, który zastępuje "uruchom tu ten inny subproces" — dzięki temu duży proces można podzielić na powiązane części zamiast jednego ogromnego, zagnieżdżonego diagramu. W drzewie każda Call Activity pokazuje swój cel pod nazwą (np. "→ Approve invoice"), albo <b>"— not set"</b>, jeśli nie jest jeszcze powiązana. Kliknięcie powiązanej (w drzewie albo przez ikonkę ↗ na kształcie) przenosi od razu do subprocesu, na który wskazuje; kliknięcie niepowiązanej pokazuje tylko "Call Activity has no target set".</p>
<p>Żeby zamienić istniejący kształt w Call Activity: zaznacz zwykły <b>Task, User Task, Service Task albo Manual Task</b> — ta opcja nie jest dostępna dla Script Task, Business Rule Task, Send Task ani Receive Task — i kliknij <b>"Mark as Call Activity ⇒"</b> w panelu właściwości. Od razu otwiera się okno wyboru docelowego subprocesu.</p>
<p><b>Okno wyboru pokazuje tylko subprocesy, które mają już własną planszę</b> — ta sama zasada "raz rozwinięte", co wyżej. Jeśli w pliku nie rozwinąłeś jeszcze żadnego subprocesu, okno pokaże "No subprocesses in this file", mimo że kształty subprocesów istnieją na płótnie. Rozwiń najpierw ten, z którym chcesz połączyć Call Activity, a potem wróć i dokonaj powiązania.</p>
<p>Panel właściwości powiązanej Call Activity pokazuje też <b>"Change target…"</b> (ponowne otwarcie okna wyboru), <b>"Go to target ↗"</b> (przejście od razu do celu) oraz <b>"Remove link (→ Task)"</b> — co zamienia ją z powrotem w zwykły Task i całkowicie kasuje powiązanie. To jednokierunkowa operacja: żeby przywrócić link, trzeba oznaczyć element jako Call Activity od nowa i ponownie wybrać cel.</p>

<h3>Breadcrumb i zapamiętywanie miejsca</h3>
<p>Gdy tylko znajdziesz się gdziekolwiek poniżej głównego procesu, nad płótnem pojawia się ścieżka nawigacyjna: przycisk <b>"↑ Back to: …"</b> dla poziomu bezpośrednio wyżej, plus pełna ścieżka z powrotem do głównego procesu — kliknięcie dowolnego wcześniejszego kroku przenosi od razu tam, bez cofania się poziom po poziomie. Klawisz <b>Escape</b> robi to samo co "Back to": cofa o jeden poziom.</p>
<p>Każdy poziom pamięta własne przesunięcie i przybliżenie. Wejdź trzy poziomy w głąb, rozejrzyj się, wróć — każdy poziom po drodze otwiera się dokładnie tam, gdzie go zostawiłeś, zamiast dopasowywać widok od nowa.</p>

<h3>Właściwości elementu</h3>
<p>Zaznaczenie dowolnego kształtu pokazuje jego właściwości po prawej stronie: nazwę, typ, kolor (dla kształtów, które go obsługują) oraz dwa pola tekstowe — <b>Description</b> i <b>Details</b>. Wszystko zapisuje się w momencie opuszczenia pola (on blur) — nie ma osobnego kroku zapisu.</p>
<p>Edytowalna szerokość/wysokość pojawia się tylko dla kształtów, które bpmn-js pozwala skalować: kontenery (rozwinięte subprocesy, pule, tory, grupy, adnotacje tekstowe), a w tym edytorze dodatkowo zwykłe Task i każdy podtyp zadania, łącznie z Call Activities. Wpisanie rozmiaru ręcznie omija zwykłe przeciąganie uchwytu, dlatego jest twardy dolny limit 10&times;10&nbsp;px, żeby literówka nie skurczyła kształtu do zera.</p>
<p>Jeśli pole <b>Details</b> zawiera adres strony, na kształcie pojawia się mała ikona linku (patrz „Rozszerzony widok szczegółów" niżej) — każdy otwierający diagram może od razu przejść na tę stronę.</p>

<h3>Systems i Locations (etykiety)</h3>
<p>W <b>Settings</b> (przycisk ⚙) zarządzasz dwiema wielokrotnego użytku listami etykiet: <b>Systems</b> i <b>Locations</b> — każda to po prostu nazwa i kolor. Po ich zdefiniowaniu panel właściwości każdego elementu pozwala wybrać System i/lub Location z rozwijanej listy, zamiast wpisywać je ręcznie za każdym razem.</p>
<p>Te listy są zapisywane na tym komputerze, a dodatkowo przy zapisie zostają wbudowane w sam plik <code>.bpmn</code> — więc podróżują razem z plikiem. Otwórz go na innym komputerze, a te same etykiety pojawią się razem z nim.</p>
<p>Ten sam panel Ustawień pozwala też ustawić <b>domyślny rozmiar dla nowo tworzonych zadań (task)</b> — stosowany automatycznie do każdego podtypu zadania (User Task, Service Task, …) przy przeciąganiu go na płótno.</p>

<h3>Rozszerzony widok szczegółów</h3>
<p>Przełącznik <b>Extended</b> w pasku narzędzi nakłada dodatkowe informacje bezpośrednio na płótno: elementy z etykietą System dostają kolorową plakietkę pod spodem, elementy z etykietą Location — nad sobą, a elementy z linkiem w polu Details — małą, klikalną ikonę ↗ prosto na diagramie. Domyślnie jest wyłączony, żeby płótno było czyste — włącz go, gdy potrzebujesz szybkiego podglądu wszystkiego naraz.</p>

<h3>Opcje wizualne</h3>
<ul>
<li>Każdy kształt, który da się pokolorować (zadania, zdarzenia, bramki, grupy, adnotacje tekstowe, …), ma w panelu właściwości wybór koloru — gotową paletę plus możliwość wybrania dowolnego własnego koloru.</li>
<li>Pule (pools) i tory (lanes) są renderowane w pełni przezroczyste, dzięki czemu siatka na płótnie jest cały czas widoczna.</li>
<li>Przycisk siatki (<b>#</b>) przełącza tło płótna: wyłączona → 10px → 50px. To wyłącznie wskazówka wizualna — nie zmienia sposobu, w jaki kształty przyciągają się do siatki.</li>
</ul>

<h3>Panel XML</h3>
<p>Przycisk <b>XML</b> otwiera boczny panel z surowym kodem XML diagramu. Można go przejrzeć, ręcznie zedytować, kliknąć <b>Import changes</b>, żeby wprowadzić zmiany z powrotem do diagramu, albo <b>Copy XML</b>, żeby skopiować go do schowka.</p>

<h3>Convert to M&amp;P BPMN</h3>
<p>Pliki utworzone w innych narzędziach czasem owijają cały proces w „collaboration" z jedną pulą (pool), czego panel Process structure tego edytora nie rozpoznaje — zamiast drzewka procesu zobaczysz wtedy „No diagram". Gdy taka naprawa jest bezpieczna (dokładnie jedna pula, brak message flow — czyli nic by nie zostało utracone), pojawia się przycisk <b>Convert to M&amp;P BPMN</b>, który jednym kliknięciem spłaszcza plik do zwykłego procesu. Jeśli konwersja mogłaby coś skasować, przycisk po prostu się nie pojawia.</p>

<h3>Skróty klawiszowe</h3>
<ul>
<li><b>Ctrl/Cmd + S</b> — zapisz</li>
<li><b>Ctrl/Cmd + O</b> — otwórz…</li>
<li><b>Ctrl/Cmd + Z</b> — cofnij</li>
<li><b>Ctrl/Cmd + Shift + Z</b> (albo <b>Ctrl/Cmd + Y</b>) — ponów</li>
</ul>

<h3>Wsparcie przeglądarek</h3>
<p>Otwieranie, zapisywanie i auto-zapis opierają się na File System Access API, dostępnym obecnie w przeglądarkach opartych na Chromium (Chrome, Edge, Brave, Arc, Opera). W innych przeglądarkach edytor nadal działa, ale zapis odbywa się przez zwykłe pobranie pliku zamiast nadpisania oryginału.</p>
`,
  ru: `<h3>Начало работы</h3>
<p>Редактор полностью работает в браузере — устанавливать ничего не нужно, сервер не используется. Диаграммы читаются и сохраняются напрямую на диск вашего компьютера.</p>
<ul>
<li><b>New</b> — создаёт пустую диаграмму.</li>
<li><b>Open…</b> — позволяет выбрать файл <code>.bpmn</code> или <code>.xml</code> с диска. Файл также можно просто перетащить на холст.</li>
<li><b>Save .bpmn</b> — сохраняет диаграмму на диск под именем, указанным в поле рядом с кнопкой.</li>
</ul>

<h3>Автосохранение и восстановление последнего файла</h3>
<p>После того как файл был открыт или сохранён через системное диалоговое окно (а не перетаскиванием), переключатель <b>Auto-save</b> автоматически сохраняет изменения обратно в этот же файл через пару секунд после того, как вы перестали редактировать — больше не нужно сохранять вручную после каждого изменения.</p>
<p>Редактор также запоминает последний открытый файл. При следующем открытии страницы он будет незаметно загружен снова. Если браузеру требуется явное подтверждение доступа, вместо автоматической загрузки в панели инструментов появится короткий запрос «Restore last file?».</p>

<h3>Панель Process structure</h3>
<p>Панель справа показывает всё содержимое диаграммы в виде одного дерева: основной процесс сверху (◈, с именем текущего файла), каждый вложенный <b>подпроцесс</b> (⊕, с отступом по глубине) и каждую <b>Call Activity</b> (⇒, с привязанной целью под названием). Клик по любой строке сразу переносит к этой части диаграммы — без прокрутки и поиска.</p>
<p><b>Войти можно только в те подпроцессы, которые хотя бы раз были развёрнуты.</b> bpmn-js создаёт отдельную "плоскость" (свою мини-диаграмму) для подпроцесса только при первом его разворачивании на холсте (маленький значок <b>+</b> на свёрнутой фигуре подпроцесса). Подпроцесс появляется в дереве и раньше — но клик по нему ничего не даёт, кроме сообщения "No plane for this subprocess (might be collapsed?)" в строке статуса. Если так случилось, найдите свёрнутый элемент на холсте и разверните его один раз; после этого он будет нормально работать в дереве.</p>
<p>Выделение фигуры подпроцесса также добавляет кнопку <b>"Enter subprocess ↗"</b> в панель его свойств — это то же самое, что клик в дереве.</p>

<h3>Call Activities: связывание подпроцессов</h3>
<p>Call Activity — это фигура, похожая на задачу, которая означает "запустить здесь этот другой подпроцесс" — так большой процесс разбивается на связанные части вместо одной гигантской вложенной диаграммы. В дереве каждая Call Activity показывает свою цель под названием (например, "→ Approve invoice"), либо <b>"— not set"</b>, если связь ещё не задана. Клик по связанной (в дереве или через значок ↗ на фигуре) сразу переносит в подпроцесс, на который она указывает; клик по несвязанной просто покажет "Call Activity has no target set".</p>
<p>Чтобы превратить существующую фигуру в Call Activity: выделите обычный <b>Task, User Task, Service Task или Manual Task</b> — эта опция недоступна для Script Task, Business Rule Task, Send Task и Receive Task — и нажмите <b>"Mark as Call Activity ⇒"</b> в панели свойств. Сразу же откроется окно выбора целевого подпроцесса.</p>
<p><b>Окно выбора показывает только те подпроцессы, у которых уже есть своя плоскость</b> — то же правило "хотя бы раз развёрнут", что и выше. Если в файле ещё не был развёрнут ни один подпроцесс, окно покажет "No subprocesses in this file", даже если фигуры подпроцессов есть на холсте. Сначала разверните нужный подпроцесс, затем вернитесь и свяжите с ним Call Activity.</p>
<p>Панель свойств связанной Call Activity также показывает <b>"Change target…"</b> (снова открыть окно выбора), <b>"Go to target ↗"</b> (перейти прямо к цели) и <b>"Remove link (→ Task)"</b> — что превращает её обратно в обычный Task и полностью удаляет связь. Это необратимое действие: чтобы восстановить связь, элемент нужно снова отметить как Call Activity и заново выбрать цель.</p>

<h3>Breadcrumb и запоминание места</h3>
<p>Как только вы оказываетесь где-либо ниже основного процесса, над холстом появляется цепочка навигации: кнопка <b>"↑ Back to: …"</b> для уровня прямо выше, плюс полный путь обратно к основному процессу — клик по любому более раннему шагу сразу переносит туда, без необходимости подниматься по одному уровню. Клавиша <b>Escape</b> делает то же самое, что и "Back to": поднимает на один уровень.</p>
<p>Каждый уровень запоминает свой сдвиг и масштаб. Зайдите на три уровня вглубь, осмотритесь, вернитесь обратно — каждый пройденный уровень откроется именно там, где вы его оставили, а не заново подгонит вид под экран.</p>

<h3>Свойства элемента</h3>
<p>При выделении любой фигуры справа отображаются её свойства: имя, тип, цвет (для фигур, которые его поддерживают) и два текстовых поля — <b>Description</b> и <b>Details</b>. Всё сохраняется в момент, когда вы покидаете поле (on blur) — отдельного шага сохранения нет.</p>
<p>Редактируемая ширина/высота появляется только для фигур, которые bpmn-js позволяет масштабировать: контейнеры (развёрнутые подпроцессы, пулы, дорожки, группы, текстовые аннотации), а в этом редакторе дополнительно — обычные Task и любой подтип задачи, включая Call Activities. Ввод размера вручную обходит обычное перетаскивание уголка, поэтому установлен жёсткий нижний предел 10&times;10&nbsp;px, чтобы опечатка не сжала фигуру до нуля.</p>
<p>Если в поле <b>Details</b> указан веб-адрес, на фигуре появляется небольшой значок ссылки (см. «Расширенный режим отображения деталей» ниже) — любой, кто откроет диаграмму, сможет сразу перейти на эту страницу.</p>

<h3>Systems и Locations (метки)</h3>
<p>В разделе <b>Settings</b> (кнопка ⚙) можно управлять двумя многоразовыми списками меток: <b>Systems</b> и <b>Locations</b> — каждая метка это просто название и цвет. После того как они заданы, в панели свойств любого элемента можно выбрать Systems и/или Location из выпадающего списка, а не вводить их вручную каждый раз.</p>
<p>Эти списки сохраняются на этом компьютере, а также встраиваются прямо в сам файл <code>.bpmn</code> при сохранении — так что они переносятся вместе с файлом. Откройте его на другом компьютере — те же метки будут доступны и там.</p>
<p>В той же панели настроек можно задать <b>размер по умолчанию для новых задач</b> — он автоматически применяется к любому подтипу задачи (User Task, Service Task, …) при перетаскивании её на холст.</p>

<h3>Расширенный режим отображения деталей</h3>
<p>Переключатель <b>Extended</b> в панели инструментов накладывает дополнительную информацию прямо на холст: элементы с меткой System получают цветной значок снизу, элементы с меткой Location — сверху, а элементы со ссылкой в поле Details — маленький кликабельный значок ↗ прямо на диаграмме. По умолчанию режим выключен, чтобы не загромождать холст — включайте его, когда нужен быстрый обзор сразу всей информации.</p>

<h3>Визуальные настройки</h3>
<ul>
<li>У каждой фигуры, которую можно раскрасить (задачи, события, шлюзы, группы, текстовые аннотации, …), в панели свойств есть выбор цвета — готовая палитра плюс возможность выбрать любой свой цвет.</li>
<li>Пулы (pools) и дорожки (lanes) отображаются полностью прозрачными, поэтому сетка на холсте всегда видна.</li>
<li>Кнопка сетки (<b>#</b>) переключает фон холста: выключено → 10px → 50px. Это чисто визуальная подсказка — она не меняет то, как фигуры примагничиваются к сетке.</li>
</ul>

<h3>Панель XML</h3>
<p>Кнопка <b>XML</b> открывает боковую панель с исходным XML-кодом диаграммы. Его можно просмотреть, отредактировать вручную, нажать <b>Import changes</b>, чтобы применить изменения обратно к диаграмме, или <b>Copy XML</b>, чтобы скопировать его в буфер обмена.</p>

<h3>Convert to M&amp;P BPMN</h3>
<p>Файлы, созданные в других инструментах, иногда оборачивают весь процесс в «collaboration» с единственным пулом — панель Process structure этого редактора такое не распознаёт, и вместо дерева процесса вы увидите «No diagram». Если исправление безопасно (ровно один пул, нет message flow — то есть ничего не будет потеряно), появляется кнопка <b>Convert to M&amp;P BPMN</b>, которая одним кликом «разворачивает» файл в обычный процесс. Если конвертация могла бы что-то удалить, кнопка просто не появляется.</p>

<h3>Горячие клавиши</h3>
<ul>
<li><b>Ctrl/Cmd + S</b> — сохранить</li>
<li><b>Ctrl/Cmd + O</b> — открыть…</li>
<li><b>Ctrl/Cmd + Z</b> — отменить</li>
<li><b>Ctrl/Cmd + Shift + Z</b> (или <b>Ctrl/Cmd + Y</b>) — повторить</li>
</ul>

<h3>Поддержка браузеров</h3>
<p>Открытие, сохранение и автосохранение основаны на File System Access API, которое сейчас доступно в браузерах на базе Chromium (Chrome, Edge, Brave, Arc, Opera). В остальных браузерах редактор всё равно работает, но сохранение происходит через обычную загрузку файла, а не перезапись оригинала.</p>
`
};
