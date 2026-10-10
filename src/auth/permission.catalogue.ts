/**
 * The fixed catalogue of permission keys. Roles are freely composed from these keys in the
 * database (`role_permissions`), editable from the "Vai trò & Quyền" screen — but the catalogue
 * itself is code, so a new capability is one deploy, never hand-written SQL.
 *
 * On boot, `PermissionCatalogueService` upserts these rows (screen / group / kind / parent) into
 * the `permissions` table; the role editor reads the checklist back from that table.
 *
 * Every key sits on the left-nav screen it belongs to (`screen`), in a section of that screen
 * (`group`), and optionally under a `parent` key: a key is only effective while every ancestor
 * is granted too, so switching off "Hiển thị xe" switches off every vehicle outline under it.
 * `kind` says what the key controls:
 *  - `screen`  — the nav entry + route itself;
 *  - `action`  — a write operation, also enforced server-side by `@RequirePermissions`;
 *  - `ui`      — a UI surface, gesture or visual (toolbar, double-click, dock tab, vehicle outline);
 *  - `column`  — one column of an Operating dock table;
 *  - `api`     — read access to the API, always granted (shown locked in the editor).
 * `screen` / `ui` / `column` keys are client-side visibility only — hiding a column never
 * protects data the API already returns to anyone signed in.
 */

export type PermissionCluster =
  | 'view'
  | 'vehicle'
  | 'order'
  | 'cargo'
  | 'area'
  | 'fleet'
  | 'map'
  | 'admin'
  | 'ui';

export type PermissionScreen =
  | 'operating'
  | 'map'
  | 'tasks'
  | 'cargo'
  | 'obstacles'
  | 'transport_orders'
  | 'vehicles'
  | 'scanner'
  | 'api_docs'
  | 'tools'
  | 'admin'
  | 'system';

export type PermissionKind = 'screen' | 'action' | 'ui' | 'column' | 'api';

export interface PermissionDef {
  key: string;
  cluster: PermissionCluster;
  screen: PermissionScreen;
  /** Section of the screen, e.g. `toolbar`, `map`, `vehicle_display`, `dock`, `col.vehicles`. */
  group: string;
  kind: PermissionKind;
  /** The key this one hangs under; effective only while the whole ancestor chain is granted. */
  parent?: string;
  /** Group C — destructive / plant-wide. Flagged red in the role editor. */
  dangerous?: boolean;
  /**
   * Which existing roles receive this key the first time it appears in an existing database,
   * so a deploy that adds a key never silently takes a capability away: `'all'` = every role,
   * a key list = roles already holding any of those keys. Omitted = nobody (admin always has
   * everything). Fresh installs use `SYSTEM_ROLE_GRANTS` instead.
   */
  defaultGrant?: 'all' | string[];
  labelVi: string;
  labelEn: string;
  labelJa: string;
}

type Labels = [vi: string, en: string, ja: string];

const def = (
  key: string,
  screen: PermissionScreen,
  group: string,
  kind: PermissionKind,
  cluster: PermissionCluster,
  [labelVi, labelEn, labelJa]: Labels,
  extra: Pick<PermissionDef, 'dangerous' | 'defaultGrant' | 'parent'> = {},
): PermissionDef => ({
  key,
  screen,
  group,
  kind,
  cluster,
  labelVi,
  labelEn,
  labelJa,
  ...extra,
});

const screenKey = (
  screen: Exclude<PermissionScreen, 'system'>,
  labels: Labels,
  defaultGrant: 'all' | string[] = 'all',
) =>
  def(`screen.${screen}`, screen, 'access', 'screen', 'view', labels, {
    defaultGrant,
  });

const OPERATING = 'screen.operating';

const opUi = (key: string, group: string, labels: Labels, parent: string) =>
  def(`op.${key}`, 'operating', group, 'ui', 'ui', labels, {
    defaultGrant: 'all',
    parent,
  });

const ACTIONS_COLUMN: [string, Labels] = [
  'act',
  ['Cột thao tác', 'Actions column', '操作列'],
];
const CREATED_COLUMN: [string, Labels] = [
  'created',
  ['Thời gian tạo', 'Created at', '作成日時'],
];

/** Operating dock tables: tab key → columns (column keys match the FE `Col.key`). */
const DOCK_TABS: [string, Labels, [string, Labels][]][] = [
  [
    'vehicles',
    ['Tab Xe', 'Vehicles tab', '車両タブ'],
    [
      ['name', ['Tên xe', 'Name', '名前']],
      ['state', ['Trạng thái', 'State', '状態']],
      ['pin', ['Pin', 'Battery', 'バッテリー']],
      ['adapter', ['Comm adapter', 'Comm adapter', '通信アダプタ']],
      ['pos', ['Vị trí', 'Position', '位置']],
      ['task', ['Nhiệm vụ', 'Task', 'タスク']],
      ['legs', ['Chặng', 'Legs', '区間']],
      ACTIONS_COLUMN,
    ],
  ],
  [
    'orders',
    ['Tab Lệnh vận chuyển', 'Orders tab', 'オーダータブ'],
    [
      ['name', ['Tên lệnh', 'Name', '名前']],
      ['type', ['Loại', 'Type', '種類']],
      ['state', ['Trạng thái', 'State', '状態']],
      ['veh', ['Xe', 'Vehicle', '車両']],
      ['dest', ['Đích', 'Destination', '目的地']],
      CREATED_COLUMN,
      ['finished', ['Thời gian xong', 'Finished at', '完了日時']],
      ACTIONS_COLUMN,
    ],
  ],
  [
    'tasks',
    ['Tab Nhiệm vụ', 'Tasks tab', 'タスクタブ'],
    [
      ['code', ['Mã nhiệm vụ', 'Task code', 'タスクコード']],
      ['kind', ['Loại', 'Kind', '種類']],
      ['item', ['Mã hàng', 'Cargo ID', '貨物ID']],
      ['state', ['Trạng thái', 'State', '状態']],
      ['veh', ['Xe', 'Vehicle', '車両']],
      ['pickup', ['Điểm lấy', 'Pickup', '積込地点']],
      ['store', ['Khu đích', 'Target area', '目的エリア']],
      ['legs', ['Chặng', 'Legs', '区間']],
      CREATED_COLUMN,
      ['finished', ['Thời gian xong', 'Finished at', '完了日時']],
      ACTIONS_COLUMN,
    ],
  ],
  [
    'areas',
    ['Tab Khu vực', 'Areas tab', 'エリアタブ'],
    [
      ['name', ['Tên khu vực', 'Name', '名前']],
      ['kind', ['Loại', 'Type', '種類']],
      ['op', ['Tác vụ', 'Operation', '操作']],
      ['lim', ['Số xe tối đa', 'Max vehicles', '最大車両数']],
      ['pts', ['Số điểm', 'Point count', '地点数']],
      ['st', ['Trạng thái', 'State', '状態']],
      ACTIONS_COLUMN,
    ],
  ],
  [
    'cargos',
    ['Tab Hàng hoá', 'Cargo tab', '貨物タブ'],
    [
      ['id', ['Mã hàng', 'Cargo ID', '貨物ID']],
      ['state', ['Trạng thái', 'State', '状態']],
      ['veh', ['Xe', 'Vehicle', '車両']],
      ['pickup', ['Điểm lấy', 'Pickup', '積込地点']],
      ['store', ['Khu đích', 'Target area', '目的エリア']],
      ['obstacle', ['Vật cản', 'Obstacle', '障害物']],
      CREATED_COLUMN,
      ['upd', ['Cập nhật', 'Updated at', '更新日時']],
      ACTIONS_COLUMN,
    ],
  ],
  [
    'obstacles',
    ['Tab Vật cản', 'Obstacles tab', '障害物タブ'],
    [
      ['item', ['Hàng', 'Item', '品目']],
      ['location', ['Vị trí', 'Location', '位置']],
      ['sync', ['Đồng bộ', 'Sync', '同期']],
      ['kernel', ['Kernel', 'Kernel', 'カーネル']],
      ['cargo', ['Trạng thái hàng', 'Cargo', '貨物']],
      ['entity', ['Thực thể', 'Entity', 'エンティティ']],
      ['updated', ['Cập nhật', 'Updated at', '更新日時']],
      ACTIONS_COLUMN,
    ],
  ],
  [
    'alarms',
    [
      'Thông báo cảnh báo (chuông)',
      'Alarm notifications (bell)',
      'アラーム通知（ベル）',
    ],
    [],
  ],
];

const dockKeys: PermissionDef[] = DOCK_TABS.flatMap(
  ([tab, labels, columns]) => [
    opUi(`dock.${tab}`, 'dock', labels, 'op.dock'),
    ...columns.map(([column, columnLabels]) =>
      def(
        `op.col.${tab}.${column}`,
        'operating',
        `col.${tab}`,
        'column',
        'ui',
        columnLabels,
        { defaultGrant: 'all', parent: `op.dock.${tab}` },
      ),
    ),
  ],
);

const vehicleCardLayoutKey = def(
  'op.dock.vehicles.detailed_layout',
  'operating',
  'dock',
  'ui',
  'ui',
  [
    'Thẻ xe đầy đủ trong dock',
    'Detailed vehicle cards in the dock',
    'ドックの詳細な車両カード',
  ],
  { parent: 'op.dock.vehicles' },
);

const vehicleCardRunningOutlineKey = def(
  'op.dock.vehicles.running_outline',
  'operating',
  'dock',
  'ui',
  'ui',
  [
    'Viền xanh thẻ xe khi đang chạy',
    'Green card outline while running',
    '走行中の車両カードの緑枠',
  ],
  { parent: 'op.dock.vehicles' },
);

const VEHICLE_CARD_FOCUS = 'op.dock.vehicles.focus';

const vehicleCardFocusKey = def(
  VEHICLE_CARD_FOCUS,
  'operating',
  'dock',
  'ui',
  'ui',
  [
    'Định vị xe trên bản đồ từ thẻ xe (click thẻ / nút định vị)',
    'Locate the vehicle on the map from its card (card click / focus button)',
    '車両カードからマップ上の車両を表示（カードクリック／フォーカスボタン）',
  ],
  {
    defaultGrant: [
      'vehicle.pause',
      'vehicle.send_to_point',
      'vehicle.comm_adapter',
      'vehicle.withdraw',
      'order.create',
      'cargo.create',
    ],
    parent: 'op.dock.vehicles',
  },
);

const vehicleCardDetailKeys: PermissionDef[] = (
  [
    [
      'position',
      [
        'Thẻ & chi tiết xe: vị trí theo node (điểm hiện tại → điểm kế, lộ trình, tài nguyên chiếm)',
        'Vehicle card & details: node position (current → next point, route, held resources)',
        '車両カード・詳細：ノード位置（現在地→次の地点、経路、占有リソース）',
      ],
    ],
    [
      'task_code',
      [
        'Thẻ & chi tiết xe: mã nhiệm vụ (TR-…)',
        'Vehicle card & details: task code (TR-…)',
        '車両カード・詳細：タスクコード（TR-…）',
      ],
    ],
    [
      'full_ids',
      [
        'Thẻ & chi tiết xe: mã lệnh / mã hàng đầy đủ (tắt = chỉ 4 ký tự cuối)',
        'Vehicle card & details: full order / cargo IDs (off = last 4 characters only)',
        '車両カード・詳細：オーダー／貨物IDを全表示（オフ＝末尾4文字のみ）',
      ],
    ],
    [
      'voltage',
      [
        'Thẻ & chi tiết xe: điện áp pin (V)',
        'Vehicle card & details: battery voltage (V)',
        '車両カード・詳細：バッテリー電圧（V）',
      ],
    ],
    [
      'all_actions',
      [
        'Thẻ xe: đủ nút thao tác (tắt = chỉ còn Dừng / Chạy và Định vị)',
        'Vehicle card: every action button (off = only Pause / Resume and Locate)',
        '車両カード：全操作ボタン（オフ＝一時停止／再開と位置表示のみ）',
      ],
    ],
  ] as [string, Labels][]
).map(([part, labels]) =>
  opUi(`dock.vehicles.card.${part}`, 'dock', labels, 'op.dock.vehicles'),
);

const VEHICLE_DISPLAY = 'op.map.vehicle';
const VEHICLE_OUTLINE = 'op.map.vehicle.outline';

const operatingKeys: PermissionDef[] = [
  screenKey('operating', [
    'Truy cập màn Vận hành',
    'Access the Operating screen',
    '運用画面へのアクセス',
  ]),

  // ── Thanh công cụ & thanh trạng thái ───────────────────────────────────────
  opUi(
    'toolbar',
    'toolbar',
    ['Thanh công cụ phía trên bản đồ', 'Map toolbar', 'マップツールバー'],
    OPERATING,
  ),
  opUi(
    'layers',
    'toolbar',
    ['Bật / tắt lớp hiển thị', 'Toggle map layers', 'レイヤーの切替'],
    'op.toolbar',
  ),
  ...(
    [
      ['areas', ['Lớp Khu vực', 'Areas layer', 'エリアレイヤー']],
      ['names', ['Lớp Tên điểm', 'Point names layer', '地点名レイヤー']],
      [
        'direction',
        ['Lớp Chiều tiến', 'Forward direction layer', '進行方向レイヤー'],
      ],
      ['type', ['Lớp Loại điểm', 'Point type layer', '地点種別レイヤー']],
      ['obstacles', ['Lớp Vật cản', 'Obstacles layer', '障害物レイヤー']],
      ['slots', ['Lớp Slot hàng', 'Cargo slots layer', '貨物スロットレイヤー']],
    ] as [string, Labels][]
  ).map(([layer, labels]) =>
    opUi(`layers.${layer}`, 'toolbar', labels, 'op.layers'),
  ),
  opUi(
    'search',
    'toolbar',
    [
      'Ô tìm kiếm nhanh (Ctrl+K)',
      'Quick search (Ctrl+K)',
      'クイック検索（Ctrl+K）',
    ],
    OPERATING,
  ),
  opUi(
    'statusbar',
    'toolbar',
    [
      'Thanh trạng thái (bộ đếm phía dưới)',
      'Status bar (bottom counters)',
      'ステータスバー（下部カウンタ）',
    ],
    OPERATING,
  ),
  def(
    'op.status.connections',
    'operating',
    'toolbar',
    'ui',
    'ui',
    [
      'Đèn kết nối riêng Kernel / MQTT / Thời gian thực (tắt = một đèn Hệ thống Online / Offline)',
      'Separate Kernel / MQTT / Realtime pills (off = one System Online / Offline pill)',
      'Kernel／MQTT／リアルタイムの個別表示（オフ＝システム オンライン／オフラインの1つ）',
    ],
    { parent: OPERATING },
  ),
  opUi(
    'status.cursor',
    'toolbar',
    [
      'Toạ độ con trỏ X / Y trên thanh trạng thái',
      'Cursor X / Y coordinates in the status bar',
      'ステータスバーのカーソル座標 X / Y',
    ],
    OPERATING,
  ),
  def('area.create', 'operating', 'toolbar', 'action', 'area', [
    'Tạo khu vực / sao chép location',
    'Create area / copy locations',
    'エリア作成／ロケーション複製',
  ]),
  def(
    'fleet.control',
    'operating',
    'toolbar',
    'action',
    'fleet',
    [
      'Kết nối / Chạy / Dừng tất cả đội xe',
      'Connect / Run / Stop all fleet',
      '全車両の接続／稼働／停止',
    ],
    { dangerous: true },
  ),

  // ── Tương tác bản đồ ───────────────────────────────────────────────────────
  opUi(
    'map',
    'map',
    ['Tương tác bản đồ', 'Map interaction', 'マップ操作'],
    OPERATING,
  ),
  opUi(
    'map.select',
    'map',
    [
      'Click chọn phần tử',
      'Click to select an element',
      'クリックで要素を選択',
    ],
    'op.map',
  ),
  opUi(
    'map.box_select',
    'map',
    [
      'Kéo khung chọn nhiều phần tử',
      'Drag a box to multi-select',
      'ドラッグで複数選択',
    ],
    'op.map',
  ),
  ...(
    [
      ['vehicle', 'xe', 'vehicles', '車両'],
      ['point', 'điểm', 'points', '地点'],
      ['path', 'đường đi', 'paths', '経路'],
      ['area', 'khu vực (Zone / Store)', 'areas (Zone / Store)', 'エリア'],
      ['cargo', 'hàng', 'cargo', '貨物'],
    ] as [string, string, string, string][]
  ).map(([kind, vi, en, ja]) =>
    opUi(
      `map.box_select.${kind}`,
      'map',
      [
        `Kéo khung chọn được ${vi}`,
        `Box-select picks up ${en}`,
        `ドラッグ選択で${ja}を選択`,
      ],
      'op.map.box_select',
    ),
  ),
  opUi(
    'map.dblclick',
    'map',
    [
      'Double-click điểm để tạo lệnh / hàng',
      'Double-click a point to create an order / cargo',
      '地点ダブルクリックでオーダー／貨物作成',
    ],
    'op.map',
  ),
  opUi(
    'map.context_menu',
    'map',
    [
      'Menu chuột phải trên điểm / xe',
      'Right-click menu on point / vehicle',
      '地点／車両の右クリックメニュー',
    ],
    'op.map',
  ),
  opUi(
    'map.drag_vehicle',
    'map',
    [
      'Kéo thả xe tới điểm để gửi xe',
      'Drag a vehicle onto a point to send it',
      '車両をドラッグして地点へ送る',
    ],
    'op.map',
  ),
  opUi(
    'map.zoom',
    'map',
    [
      'Nút phóng to / thu nhỏ / vừa màn hình',
      'Zoom / fit buttons',
      'ズーム／全体表示ボタン',
    ],
    'op.map',
  ),
  opUi(
    'map.free_zoom',
    'map',
    [
      'Zoom không giới hạn (tắt = nhỏ nhất là toàn bản đồ, lớn nhất có giới hạn)',
      'Unbounded zoom (off = whole map at the least, capped at the most)',
      'ズーム制限なし（オフ＝最小はマップ全体、最大に上限あり）',
    ],
    'op.map',
  ),
  opUi(
    'map.minimap',
    'map',
    ['Bản đồ thu nhỏ (minimap)', 'Minimap', 'ミニマップ'],
    'op.map',
  ),
  opUi(
    'map.legend',
    'map',
    ['Chú giải bản đồ', 'Map legend', '凡例'],
    'op.map',
  ),

  // ── Hiển thị xe trên bản đồ ────────────────────────────────────────────────
  opUi(
    'map.vehicle',
    'vehicle_display',
    [
      'Thông tin hiển thị trên xe',
      'Overlays drawn on vehicles',
      '車両上のオーバーレイ表示',
    ],
    OPERATING,
  ),
  opUi(
    'map.vehicle.label',
    'vehicle_display',
    ['Nhãn tên xe', 'Vehicle name label', '車両名ラベル'],
    VEHICLE_DISPLAY,
  ),
  opUi(
    'map.vehicle.label.all',
    'vehicle_display',
    [
      'Nhãn cả trên xe đang chạy lệnh (tắt = ẩn nhãn xe đang chạy bình thường; xe rảnh / lỗi / dừng / đang chọn vẫn hiện)',
      'Labels on executing vehicles too (off = hidden while executing normally; idle / faulted / halted / selected ones keep theirs)',
      '走行中の車両にもラベル（オフ＝正常走行中は非表示。待機／エラー／停止／選択中は表示）',
    ],
    'op.map.vehicle.label',
  ),
  opUi(
    'map.vehicle.outline',
    'vehicle_display',
    ['Viền trạng thái xe', 'Vehicle status outline', '車両状態の枠'],
    VEHICLE_DISPLAY,
  ),
  opUi(
    'map.vehicle.outline.running',
    'vehicle_display',
    ['Viền xanh — đang chạy', 'Green outline — running', '緑枠 — 走行中'],
    VEHICLE_OUTLINE,
  ),
  opUi(
    'map.vehicle.outline.alarm',
    'vehicle_display',
    [
      'Viền đỏ nhấp nháy — lỗi',
      'Blinking red outline — error',
      '赤点滅枠 — エラー',
    ],
    VEHICLE_OUTLINE,
  ),
  opUi(
    'map.vehicle.outline.halted',
    'vehicle_display',
    [
      'Viền đỏ — tạm dừng / dừng khẩn',
      'Red outline — paused / e-stop',
      '赤枠 — 一時停止／非常停止',
    ],
    VEHICLE_OUTLINE,
  ),
  opUi(
    'map.vehicle.outline.caution',
    'vehicle_display',
    [
      'Viền vàng nhấp nháy — cảnh báo',
      'Blinking amber outline — warning',
      '黄点滅枠 — 警告',
    ],
    VEHICLE_OUTLINE,
  ),
  opUi(
    'map.vehicle.rotation',
    'vehicle_display',
    [
      'Vòng tròn khi xe xoay tại chỗ',
      'Circle while turning in place',
      'その場旋回の円',
    ],
    VEHICLE_DISPLAY,
  ),
  opUi(
    'map.vehicle.error_badge',
    'vehicle_display',
    [
      'Bong bóng / chữ lỗi giữa xe',
      'Error badge on the vehicle',
      '車両上のエラーバッジ',
    ],
    VEHICLE_DISPLAY,
  ),
  opUi(
    'map.vehicle.hover',
    'vehicle_display',
    [
      'Thẻ chi tiết lỗi khi rê chuột lên xe',
      'Issue card on vehicle hover',
      'ホバー時のエラー詳細カード',
    ],
    VEHICLE_DISPLAY,
  ),
  opUi(
    'map.vehicle.route',
    'vehicle_display',
    ['Đường lộ trình xe', 'Vehicle route line', '車両の経路線'],
    VEHICLE_DISPLAY,
  ),
  opUi(
    'map.vehicle.route.all',
    'vehicle_display',
    [
      'Lộ trình của mọi xe (tắt = chỉ xe đang chọn)',
      'Routes of every vehicle (off = only the selected one)',
      '全車両の経路（オフ＝選択中の車両のみ）',
    ],
    'op.map.vehicle.route',
  ),
  opUi(
    'map.vehicle.drop_preview',
    'vehicle_display',
    [
      'Nhấp nháy điểm hạ hàng sắp tới',
      'Upcoming drop-off pulse',
      '次の荷下ろし地点の点滅',
    ],
    VEHICLE_DISPLAY,
  ),

  // ── Bảng chi tiết phần tử ──────────────────────────────────────────────────
  opUi(
    'drawer',
    'drawer',
    [
      'Bảng chi tiết phần tử (panel phải)',
      'Element detail panel (right)',
      '要素詳細パネル（右）',
    ],
    OPERATING,
  ),
  opUi(
    'drawer.vehicle',
    'drawer',
    ['Chi tiết xe', 'Vehicle details', '車両の詳細'],
    'op.drawer',
  ),
  opUi(
    'drawer.point',
    'drawer',
    ['Chi tiết điểm', 'Point details', '地点の詳細'],
    'op.drawer',
  ),
  opUi(
    'drawer.path',
    'drawer',
    ['Chi tiết đường đi', 'Path details', '経路の詳細'],
    'op.drawer',
  ),
  opUi(
    'drawer.area',
    'drawer',
    ['Chi tiết khu vực', 'Area details', 'エリアの詳細'],
    'op.drawer',
  ),
  opUi(
    'drawer.cargo',
    'drawer',
    ['Chi tiết hàng', 'Cargo details', '貨物の詳細'],
    'op.drawer',
  ),
  opUi(
    'drawer.multi',
    'drawer',
    ['Bảng chọn nhiều phần tử', 'Multi-selection panel', '複数選択パネル'],
    'op.drawer',
  ),
  opUi(
    'drawer.multi.bulk',
    'drawer',
    [
      'Thao tác hàng loạt trên vùng chọn (dừng xe, thêm / xoá hàng, xoá khu vực — còn cần quyền thao tác tương ứng)',
      'Bulk actions on the selection (pause vehicles, add / delete cargo, delete areas — also needs the matching action keys)',
      '選択範囲の一括操作（車両停止、貨物の追加／削除、エリア削除 — 各操作の権限も必要）',
    ],
    'op.drawer.multi',
  ),

  // ── Điều khiển xe ──────────────────────────────────────────────────────────
  def('vehicle.pause', 'operating', 'vehicle', 'action', 'vehicle', [
    'Tạm dừng / tiếp tục xe',
    'Pause / resume vehicle',
    '車両の一時停止／再開',
  ]),
  def(
    'vehicle.integration_level',
    'operating',
    'vehicle',
    'action',
    'vehicle',
    [
      'Đổi mức tích hợp xe',
      'Change vehicle integration level',
      '車両の統合レベルを変更',
    ],
  ),
  def('vehicle.comm_adapter', 'operating', 'vehicle', 'action', 'vehicle', [
    'Kết nối / ngắt comm adapter, đưa xe online',
    'Connect / disconnect comm adapter, bring online',
    '通信アダプタの接続／切断、オンライン化',
  ]),
  def('vehicle.send_to_point', 'operating', 'vehicle', 'action', 'vehicle', [
    'Gửi xe tới điểm',
    'Send vehicle to point',
    '車両を地点へ送る',
  ]),
  def('vehicle.withdraw', 'operating', 'vehicle', 'action', 'vehicle', [
    'Rút đơn khỏi xe',
    'Withdraw order from vehicle',
    '車両からオーダーを取り消す',
  ]),
  def('vehicle.stop_charging', 'operating', 'vehicle', 'action', 'vehicle', [
    'Dừng sạc xe ngay lập tức',
    'Stop vehicle charging immediately',
    '車両の充電を即時停止',
  ]),
  def(
    'path.lock',
    'operating',
    'vehicle',
    'action',
    'fleet',
    ['Khoá / mở đường đi', 'Lock / unlock path', '経路のロック／解除'],
    { dangerous: true },
  ),

  // ── Lệnh, nhiệm vụ & hàng ──────────────────────────────────────────────────
  def('order.create', 'operating', 'order', 'action', 'order', [
    'Tạo đơn vận chuyển',
    'Create transport order',
    '搬送オーダーを作成',
  ]),
  def('order.withdraw', 'operating', 'order', 'action', 'order', [
    'Rút / huỷ đơn vận chuyển',
    'Withdraw transport order',
    '搬送オーダーを取り消す',
  ]),
  def('task.cancel', 'operating', 'order', 'action', 'order', [
    'Huỷ nhiệm vụ không có hàng (lệnh tay, đỗ, sạc)',
    'Cancel non-cargo tasks (manual, park, charge)',
    '貨物なしタスクをキャンセル（手動・駐車・充電）',
  ]),
  def('cargo.create', 'operating', 'order', 'action', 'cargo', [
    'Tạo yêu cầu hàng',
    'Create cargo',
    '貨物を作成',
  ]),
  def('cargo.cancel', 'operating', 'order', 'action', 'cargo', [
    'Huỷ / xoá yêu cầu hàng',
    'Cancel / delete cargo',
    '貨物をキャンセル／削除',
  ]),
  def('cargo.redirect', 'operating', 'order', 'action', 'cargo', [
    'Đổi kho đích của hàng',
    'Redirect cargo target store',
    '貨物の目的ストアを変更',
  ]),

  // ── Khu vực ────────────────────────────────────────────────────────────────
  def('area.edit', 'operating', 'area', 'action', 'area', [
    'Sửa khu vực & điểm thành viên',
    'Edit area & members',
    'エリアとメンバーを編集',
  ]),
  def(
    'area.delete',
    'operating',
    'area',
    'action',
    'area',
    ['Xoá khu vực', 'Delete area', 'エリアを削除'],
    { dangerous: true },
  ),
  def(
    'area.purge_cargo',
    'operating',
    'area',
    'action',
    'area',
    [
      'Xoá toàn bộ hàng đã hoàn thành của khu vực',
      'Delete every finished cargo of an area',
      'エリアの完了済み貨物をすべて削除',
    ],
    { dangerous: true },
  ),
  def('area.sync_kernel', 'operating', 'area', 'action', 'area', [
    'Đồng bộ khu vực với kernel',
    'Sync areas with kernel',
    'カーネルとエリアを同期',
  ]),

  // ── Bảng dưới (dock), tab và cột ───────────────────────────────────────────
  opUi(
    'dock',
    'dock',
    ['Bảng dưới (dock)', 'Bottom dock', '下部ドック'],
    OPERATING,
  ),
  opUi(
    'dock.row_dblclick',
    'dock',
    [
      'Double-click dòng để định vị / mở chi tiết',
      'Double-click a row to locate / open details',
      '行ダブルクリックで位置表示／詳細',
    ],
    'op.dock',
  ),
  opUi(
    'order_detail.table_tools',
    'dock',
    [
      'Sắp xếp và tìm kiếm bảng chi tiết lệnh',
      'Order detail table sort and search',
      'オーダー詳細表の並べ替えと検索',
    ],
    'op.dock',
  ),
  opUi(
    'dock.bulk',
    'dock',
    [
      'Chọn nhiều dòng & thao tác hàng loạt',
      'Row checkboxes & bulk actions',
      '行の複数選択と一括操作',
    ],
    'op.dock',
  ),
  opUi(
    'dock.move',
    'dock',
    [
      'Kéo / ghim / đổi cỡ bảng dưới',
      'Drag / pin / resize the dock',
      'ドックの移動／固定／サイズ変更',
    ],
    'op.dock',
  ),
  ...dockKeys,
  vehicleCardLayoutKey,
  vehicleCardRunningOutlineKey,
  vehicleCardFocusKey,
  ...vehicleCardDetailKeys,
];

const otherScreenKeys: PermissionDef[] = [
  screenKey('map', [
    'Truy cập màn Bản đồ',
    'Access the Map screen',
    'マップ画面へのアクセス',
  ]),
  def(
    'map.table_tools',
    'map',
    'columns',
    'ui',
    'ui',
    [
      'Sắp xếp và tìm kiếm danh sách thành phần bản đồ',
      'Map component table sort and search',
      'マップ構成要素表の並べ替えと検索',
    ],
    { defaultGrant: 'all', parent: 'screen.map' },
  ),
  def('map.download', 'map', 'actions', 'action', 'map', [
    'Tải bản đồ đã lưu (XML)',
    'Download stored maps (XML)',
    '保存済みマップをダウンロード',
  ]),
  def(
    'map.upload',
    'map',
    'actions',
    'action',
    'map',
    [
      'Upload bản đồ vào WES / nạp vào kernel',
      'Upload maps to WES / load into kernel',
      'WESへアップロード／カーネルへ読込',
    ],
    { dangerous: true },
  ),
  def(
    'map.delete',
    'map',
    'actions',
    'action',
    'map',
    [
      'Xoá bản đồ khỏi thư viện WES',
      'Delete maps from the WES library',
      'WESライブラリからマップを削除',
    ],
    { dangerous: true },
  ),

  screenKey('tasks', [
    'Truy cập màn Nhiệm vụ',
    'Access the Tasks screen',
    'タスク画面へのアクセス',
  ]),
  def(
    'tasks.table_tools',
    'tasks',
    'columns',
    'ui',
    'ui',
    [
      'Sắp xếp và tìm kiếm cột nhiệm vụ',
      'Task column sort and search',
      'タスク列の並べ替えと検索',
    ],
    { defaultGrant: 'all', parent: 'screen.tasks' },
  ),

  screenKey('cargo', [
    'Truy cập màn Quản lý hàng hóa',
    'Access the Cargo management screen',
    '貨物管理画面へのアクセス',
  ]),
  def(
    'cargo.filters',
    'cargo',
    'filters',
    'ui',
    'ui',
    ['Bộ lọc hàng hóa', 'Cargo filters', '貨物フィルター'],
    { defaultGrant: 'all', parent: 'screen.cargo' },
  ),
  def(
    'cargo.summary',
    'cargo',
    'summary',
    'ui',
    'ui',
    ['Bảng tổng hợp hàng hóa', 'Cargo summary', '貨物集計'],
    { defaultGrant: 'all', parent: 'screen.cargo' },
  ),
  ...(
    [
      ['code', 'Mã hàng', 'Cargo code', '貨物コード'],
      ['map', 'Bản đồ', 'Map', 'マップ'],
      ['status', 'Trạng thái', 'Status', '状態'],
      ['task', 'Trạng thái nhiệm vụ', 'Task status', 'タスク状態'],
      ['source', 'Điểm lấy', 'Pickup point', '積込地点'],
      ['destination', 'Điểm đích', 'Destination', '目的地'],
      ['vehicle', 'Xe', 'Vehicle', '車両'],
      ['created', 'Thời gian tạo', 'Created at', '作成日時'],
      ['updated', 'Cập nhật', 'Updated at', '更新日時'],
    ] as [string, string, string, string][]
  ).map(([key, vi, en, ja]) =>
    def(`cargo.col.${key}`, 'cargo', 'columns', 'column', 'ui', [vi, en, ja], {
      defaultGrant: 'all',
      parent: 'screen.cargo',
    }),
  ),

  screenKey('obstacles', [
    'Truy cập màn Vật cản',
    'Access the Obstacles screen',
    '障害物画面へのアクセス',
  ]),
  def(
    'obstacles.manage',
    'obstacles',
    'actions',
    'action',
    'cargo',
    [
      'Retire / kích hoạt lại vật cản trên openTCS',
      'Retire / reactivate obstacles on openTCS',
      'openTCS上の障害物を廃止／再有効化',
    ],
    { dangerous: true },
  ),

  screenKey(
    'scanner',
    [
      'Truy cập màn Máy quét (thử API FMS cũ)',
      'Access the Scanner screen (legacy FMS API tester)',
      'スキャナー画面へのアクセス（旧FMS APIテスト）',
    ],
    ['cargo.create'],
  ),
  def(
    'scanner.add_cargo',
    'scanner',
    'actions',
    'ui',
    'cargo',
    [
      'Nút Thêm hàng trên máy quét (còn cần quyền Tạo hàng)',
      'Add-cargo button on the scanner (also needs Create cargo)',
      'スキャナーの荷物追加ボタン（荷物作成権限も必要）',
    ],
    { defaultGrant: ['cargo.create'], parent: 'screen.scanner' },
  ),
  def(
    'scanner.suggestions',
    'scanner',
    'scanner_assist',
    'ui',
    'ui',
    [
      'Gợi ý, điền sẵn & chọn ngẫu nhiên vị trí / đích hợp lệ',
      'Suggest, prefill & randomly pick valid positions / destinations',
      '有効な位置／搬送先の候補・自動入力・ランダム選択',
    ],
    { defaultGrant: 'all', parent: 'screen.scanner' },
  ),
  def(
    'scanner.request_log',
    'scanner',
    'scanner_assist',
    'ui',
    'ui',
    [
      'Nhật ký request: body thô, mã HTTP, chép cURL',
      'Request log: raw bodies, HTTP status, copy cURL',
      'リクエストログ：生のボディ・HTTPステータス・cURLコピー',
    ],
    { defaultGrant: 'all', parent: 'screen.scanner' },
  ),
  def(
    'scanner.swagger_link',
    'scanner',
    'scanner_assist',
    'ui',
    'ui',
    [
      'Nút mở tài liệu API máy quét (cần thêm quyền màn API)',
      'Open scanner API docs button (also needs the API screen)',
      'スキャナーAPI文書を開くボタン（API画面の権限も必要）',
    ],
    { defaultGrant: 'all', parent: 'screen.scanner' },
  ),

  screenKey(
    'api_docs',
    [
      'Truy cập màn Tài liệu API (Swagger)',
      'Access the API docs (Swagger) screen',
      'API文書（Swagger）画面へのアクセス',
    ],
    ['users.manage'],
  ),
  def('api_docs.wes', 'api_docs', 'layers', 'action', 'view', [
    'Xem tài liệu API tầng WES (/api/*)',
    'View WES layer API docs (/api/*)',
    'WES層のAPI文書を閲覧（/api/*）',
  ]),
  def('api_docs.legacy_fms', 'api_docs', 'layers', 'action', 'view', [
    'Xem tài liệu API Legacy FMS v1 — máy quét (/api/v1/*)',
    'View Legacy FMS v1 (scanner) API docs (/api/v1/*)',
    '旧FMS v1（スキャナー）API文書を閲覧（/api/v1/*）',
  ]),
  def('api_docs.kernel_v1', 'api_docs', 'layers', 'action', 'view', [
    'Xem tài liệu API tầng Kernel — openTCS v1 (:55200)',
    'View Kernel layer API docs — openTCS v1 (:55200)',
    'カーネル層API文書を閲覧 — openTCS v1（:55200）',
  ]),
  def('api_docs.kernel_v8', 'api_docs', 'layers', 'action', 'view', [
    'Xem tài liệu API tầng Kernel — openTCS v8 preview (:55300)',
    'View Kernel layer API docs — openTCS v8 preview (:55300)',
    'カーネル層API文書を閲覧 — openTCS v8 preview（:55300）',
  ]),

  // Floating tool windows opened from the "Công cụ" nav group. Visibility only — every write
  // inside a tool still goes through the server-enforced action keys (vehicle.pause,
  // fleet.control, cargo.create, cargo.cancel).
  screenKey(
    'tools',
    [
      'Hiện nhóm Công cụ trên menu trái',
      'Show the Tools group in the left nav',
      '左メニューにツールグループを表示',
    ],
    ['vehicle.pause', 'fleet.control', 'cargo.create'],
  ),
  def(
    'tools.agv',
    'tools',
    'cards',
    'ui',
    'ui',
    [
      'Thẻ công cụ AGV (xem nhanh, dừng / chạy xe)',
      'AGV tool card (fleet glance, pause / resume)',
      'AGVツールカード（概要、停止／再開）',
    ],
    {
      defaultGrant: ['vehicle.pause', 'fleet.control'],
      parent: 'screen.tools',
    },
  ),
  def(
    'tools.cargo_generator',
    'tools',
    'cards',
    'ui',
    'ui',
    [
      'Thẻ công cụ Tạo hàng theo lịch',
      'Scheduled cargo tool card',
      'スケジュール荷物生成ツールカード',
    ],
    { defaultGrant: ['cargo.create'], parent: 'screen.tools' },
  ),
  // The shared AGV simulator board. Seeing it is harmless; `simulator.manage` publishes vehicle
  // states to the VDA5050 broker, so it is flagged dangerous and granted to nobody but admin.
  def(
    'tools.simulator',
    'tools',
    'cards',
    'ui',
    'ui',
    [
      'Thẻ công cụ Mô phỏng AGV (bảng xe ảo dùng chung)',
      'AGV simulator tool card (shared virtual fleet)',
      'AGVシミュレーターツールカード（共有仮想車両）',
    ],
    { parent: 'screen.tools' },
  ),
  def(
    'simulator.manage',
    'tools',
    'actions',
    'action',
    'fleet',
    [
      'Điều khiển bộ mô phỏng AGV (thêm / xoá / bật / tắt xe ảo, tiêm lỗi, đặt pin)',
      'Control the AGV simulator (add / remove / power virtual AGVs, inject errors, set battery)',
      'AGVシミュレーターの操作（仮想車両の追加・削除・電源、エラー注入、バッテリー設定）',
    ],
    { dangerous: true },
  ),

  screenKey('transport_orders', [
    'Truy cập màn Lệnh vận chuyển',
    'Access the Transport orders screen',
    '搬送オーダー画面へのアクセス',
  ]),
  def(
    'transport_orders.table_tools',
    'transport_orders',
    'columns',
    'ui',
    'ui',
    [
      'Sắp xếp và tìm kiếm cột lệnh',
      'Order column sort and search',
      'オーダー列の並べ替えと検索',
    ],
    { defaultGrant: 'all', parent: 'screen.transport_orders' },
  ),

  screenKey(
    'vehicles',
    [
      'Truy cập màn Xe (AGV)',
      'Access the Vehicles (AGV) screen',
      '車両（AGV）画面へのアクセス',
    ],
    ['agvs.manage'],
  ),
  def(
    'vehicles.table_tools',
    'vehicles',
    'columns',
    'ui',
    'ui',
    [
      'Sắp xếp và tìm kiếm cột xe',
      'Vehicle column sort and search',
      '車両列の並べ替えと検索',
    ],
    { defaultGrant: 'all', parent: 'screen.vehicles' },
  ),
  def(
    'agvs.manage',
    'vehicles',
    'actions',
    'action',
    'admin',
    ['Quản lý đăng ký AGV', 'Manage AGV registry', 'AGV登録管理'],
    { dangerous: true },
  ),
  def('agvs.battery_thresholds', 'vehicles', 'actions', 'action', 'fleet', [
    'Sửa ngưỡng pin của xe (nguy hiểm / tốt / đủ / đầy)',
    'Edit vehicle battery thresholds (critical / good / sufficient / full)',
    '車両のバッテリー閾値の編集（危険／良好／十分／満充電）',
  ]),
  def(
    'dispatch.manage',
    'vehicles',
    'actions',
    'action',
    'admin',
    [
      'Quản lý chính sách điều phối',
      'Manage dispatch policies',
      '配車ポリシー管理',
    ],
    { dangerous: true },
  ),

  screenKey(
    'admin',
    [
      'Truy cập màn Người dùng & Phân quyền',
      'Access the Users & Permissions screen',
      'ユーザーと権限画面へのアクセス',
    ],
    ['users.view', 'users.manage', 'roles.manage', 'tokens.manage'],
  ),
  def(
    'admin.table_tools',
    'admin',
    'columns',
    'ui',
    'ui',
    [
      'Sắp xếp và tìm kiếm cột người dùng',
      'User column sort and search',
      'ユーザー列の並べ替えと検索',
    ],
    { defaultGrant: 'all', parent: 'screen.admin' },
  ),
  def('users.view', 'admin', 'actions', 'action', 'admin', [
    'Xem người dùng & vai trò',
    'View users & roles',
    'ユーザーとロールを表示',
  ]),
  def(
    'users.manage',
    'admin',
    'actions',
    'action',
    'admin',
    [
      'Quản lý người dùng (tạo / sửa / xoá / gán vai trò)',
      'Manage users (create / edit / delete / assign role)',
      'ユーザー管理（作成／編集／削除／ロール割当）',
    ],
    { dangerous: true },
  ),
  def(
    'roles.manage',
    'admin',
    'actions',
    'action',
    'admin',
    [
      'Quản lý vai trò & ma trận quyền',
      'Manage roles & permission matrix',
      'ロールと権限マトリクスを管理',
    ],
    { dangerous: true },
  ),
  def(
    'tokens.manage',
    'admin',
    'actions',
    'action',
    'admin',
    [
      'Cấp / thu hồi token vĩnh viễn',
      'Issue / revoke permanent tokens',
      '永続トークンの発行／取消',
    ],
    { dangerous: true },
  ),

  def('map.view', 'system', 'api', 'api', 'view', [
    'Đọc dữ liệu bản đồ & phần tử (luôn bật)',
    'Read map & element data (always on)',
    'マップと要素データの読取（常時有効）',
  ]),
  def('list.view', 'system', 'api', 'api', 'view', [
    'Đọc các danh sách (luôn bật)',
    'Read list data (always on)',
    'リストデータの読取（常時有効）',
  ]),
];

export const PERMISSION_CATALOGUE: PermissionDef[] = [
  ...operatingKeys,
  ...otherScreenKeys,
];

/** Permission keys always granted to any authenticated user, regardless of role. */
export const IMPLICIT_VIEW_PERMISSIONS = ['map.view', 'list.view'] as const;

export const ALL_PERMISSION_KEYS: string[] = PERMISSION_CATALOGUE.map(
  (p) => p.key,
);

/** Keys that only toggle client-side visibility (no server-side enforcement). */
export const UI_PERMISSION_KEYS: string[] = PERMISSION_CATALOGUE.filter(
  (p) => p.kind === 'screen' || p.kind === 'ui' || p.kind === 'column',
).map((p) => p.key);

const PARENT_OF = new Map(
  PERMISSION_CATALOGUE.filter((p) => p.parent).map((p) => [
    p.key,
    p.parent as string,
  ]),
);

/** Drops every key whose ancestor chain is not fully granted. */
export function effectivePermissions(
  granted: ReadonlySet<string>,
): Set<string> {
  const hasFullChain = (key: string): boolean => {
    const parent = PARENT_OF.get(key);
    return !parent || (granted.has(parent) && hasFullChain(parent));
  };
  return new Set([...granted].filter(hasFullChain));
}

const keysOfScreens = (...screens: PermissionScreen[]): string[] =>
  PERMISSION_CATALOGUE.filter((p) => screens.includes(p.screen)).map(
    (p) => p.key,
  );

const dockColumns = (tab: string, only?: string[]): string[] =>
  PERMISSION_CATALOGUE.filter(
    (p) =>
      p.group === `col.${tab}` &&
      (!only || only.some((column) => p.key === `op.col.${tab}.${column}`)),
  ).map((p) => p.key);

const VIEWER_GRANTS = [
  ...IMPLICIT_VIEW_PERMISSIONS,
  OPERATING,
  'op.toolbar',
  'op.layers',
  'op.layers.areas',
  'op.layers.names',
  'op.layers.direction',
  'op.search',
  'op.statusbar',
  'op.map',
  'op.map.select',
  'op.map.zoom',
  'op.map.legend',
  VEHICLE_DISPLAY,
  'op.map.vehicle.label',
  VEHICLE_OUTLINE,
  'op.map.vehicle.outline.running',
  'op.map.vehicle.outline.alarm',
  'op.map.vehicle.outline.halted',
  'op.map.vehicle.outline.caution',
  'op.map.vehicle.rotation',
  'op.map.vehicle.error_badge',
  'op.map.vehicle.hover',
  'op.map.vehicle.route',
  'op.map.vehicle.drop_preview',
  'op.drawer',
  'op.drawer.vehicle',
  'op.dock',
  'op.dock.row_dblclick',
  'op.dock.move',
  'op.dock.vehicles',
  ...dockColumns('vehicles', ['name', 'state', 'pin']),
  'op.dock.alarms',
];

const SCANNER_GRANTS = [
  ...VIEWER_GRANTS,
  'cargo.create',
  'cargo.cancel',
  'op.map.dblclick',
  'op.drawer.point',
  'op.drawer.cargo',
];

const MAPPER_GRANTS = [
  ...VIEWER_GRANTS,
  'area.create',
  'area.edit',
  'area.delete',
  'area.sync_kernel',
  'area.purge_cargo',
  'op.drawer.point',
  'op.drawer.area',
  'op.drawer.multi',
  'op.drawer.multi.bulk',
  'op.map.box_select',
  'op.map.box_select.point',
  'op.map.box_select.area',
  ...keysOfScreens('map'),
];

const OPERATOR_GRANTS = [
  ...SCANNER_GRANTS,
  ...MAPPER_GRANTS,
  'vehicle.send_to_point',
  'vehicle.pause',
  'vehicle.comm_adapter',
  'vehicle.stop_charging',
  'fleet.control',
  'cargo.redirect',
  'op.map.context_menu',
  'op.map.drag_vehicle',
  'op.map.box_select.vehicle',
  'op.map.box_select.cargo',
  'op.map.minimap',
  'op.status.connections',
  'op.status.cursor',
  ...dockColumns('vehicles'),
  VEHICLE_CARD_FOCUS,
  'op.dock.bulk',
  'op.dock.cargos',
  ...dockColumns('cargos'),
  'op.dock.areas',
  ...dockColumns('areas'),
  ...keysOfScreens('cargo'),
  'screen.vehicles',
  'vehicles.table_tools',
  'agvs.manage',
  'agvs.battery_thresholds',
];

const DISPATCHER_GRANTS = [
  ...OPERATOR_GRANTS,
  'order.create',
  'order.withdraw',
  'task.cancel',
  'vehicle.withdraw',
  'op.order_detail.table_tools',
  'op.dock.tasks',
  ...dockColumns('tasks'),
  ...keysOfScreens('tasks'),
];

const TESTER_GRANTS = [
  ...DISPATCHER_GRANTS,
  ...keysOfScreens('scanner', 'api_docs'),
  'screen.tools',
  'tools.agv',
  'tools.cargo_generator',
];

const PERMISSION_ADMIN_KEYS = new Set(keysOfScreens('admin'));

const unique = (keys: string[]): string[] => [...new Set(keys)];

/**
 * Baseline grants of the system roles, each tier holding everything of the tier before it:
 * viewer → scanner / mapper → operator → dispatcher → tester → dev → admin. Seeded when the role
 * has no grants yet; a key added to the catalogue later reaches a system role only when its
 * baseline lists it.
 */
export const SYSTEM_ROLE_GRANTS: Record<string, string[]> = {
  admin: ALL_PERMISSION_KEYS,
  dev: ALL_PERMISSION_KEYS.filter((key) => !PERMISSION_ADMIN_KEYS.has(key)),
  tester: unique(TESTER_GRANTS),
  dispatcher: unique(DISPATCHER_GRANTS),
  operator: unique(OPERATOR_GRANTS),
  mapper: unique(MAPPER_GRANTS),
  scanner: unique(SCANNER_GRANTS),
  viewer: unique(VIEWER_GRANTS),
};

/**
 * Roles that should receive a key when it first appears in an existing database, given each
 * role's current grants. See `PermissionDef.defaultGrant`.
 */
export function rolesGrantedOnIntroduction(
  permission: Pick<PermissionDef, 'defaultGrant'>,
  grantsByRole: ReadonlyMap<number, ReadonlySet<string>>,
): number[] {
  const rule = permission.defaultGrant;
  if (!rule) return [];
  return [...grantsByRole.entries()]
    .filter(([, grants]) => rule === 'all' || rule.some((k) => grants.has(k)))
    .map(([roleId]) => roleId);
}
