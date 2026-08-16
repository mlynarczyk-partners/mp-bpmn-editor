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

<h3>Finding your way around a large process</h3>
<p>The <b>Process structure</b> panel on the right lists your main process together with every sub-process and Call Activity inside it. Click any entry to jump straight to that part of the diagram.</p>
<p>Once you've drilled into a sub-process, a breadcrumb trail appears above the canvas so you always know where you are and can jump back up a level.</p>
<p><b>Call Activities</b> can be linked to point at any sub-process in your file (via the properties panel, see below) — clicking the link icon on the shape jumps straight into the linked sub-process. A Call Activity can also be converted back into a plain Task if you no longer need the link.</p>

<h3>Element properties</h3>
<p>Select any shape to see its properties on the right: name, type, an editable size (for shapes bpmn-js allows resizing), a color, and two free-text fields — <b>Description</b> and <b>Details</b>. Everything is saved automatically as you edit it (on blur, i.e. when you click away from the field).</p>
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

<h3>Poruszanie się po rozbudowanym procesie</h3>
<p>Panel <b>Process structure</b> po prawej stronie pokazuje główny proces wraz ze wszystkimi zagnieżdżonymi subprocesami i Call Activities. Kliknięcie dowolnej pozycji przenosi od razu do tej części diagramu.</p>
<p>Po wejściu w subproces nad płótnem pojawia się ścieżka nawigacyjna (breadcrumb), dzięki której zawsze wiadomo, gdzie się jest, i można łatwo cofnąć się o poziom wyżej.</p>
<p><b>Call Activities</b> można powiązać z dowolnym subprocesem w pliku (przez panel właściwości, opisany niżej) — kliknięcie ikony linku na elemencie przenosi od razu do powiązanego subprocesu. Call Activity można też w każdej chwili zamienić z powrotem na zwykły Task, jeśli powiązanie nie jest już potrzebne.</p>

<h3>Właściwości elementu</h3>
<p>Zaznaczenie dowolnego kształtu pokazuje jego właściwości po prawej stronie: nazwę, typ, edytowalny rozmiar (dla kształtów, które bpmn-js pozwala skalować), kolor oraz dwa pola tekstowe — <b>Description</b> i <b>Details</b>. Wszystko zapisuje się automatycznie w trakcie edycji (w momencie opuszczenia pola).</p>
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

<h3>Навигация по большому процессу</h3>
<p>Панель <b>Process structure</b> справа показывает основной процесс вместе со всеми вложенными подпроцессами и Call Activities. Клик по любому пункту сразу переносит к этой части диаграммы.</p>
<p>После перехода внутрь подпроцесса над холстом появляется цепочка навигации (breadcrumb), которая всегда показывает, где вы находитесь, и позволяет быстро вернуться на уровень выше.</p>
<p><b>Call Activities</b> можно связать с любым подпроцессом в файле (через панель свойств, см. ниже) — клик по значку ссылки на элементе сразу открывает связанный подпроцесс. Call Activity также можно в любой момент превратить обратно в обычную задачу (Task), если связь больше не нужна.</p>

<h3>Свойства элемента</h3>
<p>При выделении любой фигуры справа отображаются её свойства: имя, тип, редактируемый размер (для фигур, изменение размера которых разрешено в bpmn-js), цвет и два текстовых поля — <b>Description</b> и <b>Details</b>. Всё сохраняется автоматически по мере редактирования (при выходе из поля).</p>
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
