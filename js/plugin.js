// ============================================================
// Eagle 同步器 - 主插件逻辑 v2
// ============================================================
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Bonjour } = require('bonjour-service');

// ============================================================
// 全局状态
// ============================================================
const STATE = {
  mode: null,           // 'host' | 'client'
  server: null,         // HTTP server instance
  bonjour: null,        // Bonjour instance
  bonjourBrowser: null,
  bonjourService: null,
  localIP: '',
  port: 12480,
  peers: [],            // discovered peers
  connectedHost: null,  // { ip, port }
  libraryPath: '',
  folders: [],          // Eagle folder tree (local)
  localFolders: [],     // 客户端本地文件夹（用于选择目标）
  selectedFolderIds: new Set(),
  allItems: [],         // items cache
  syncing: false,
  allSelected: false,
  targetFolderId: null, // 客户端同步目标文件夹
};

const SERVICE_TYPE = 'eagle-sync';

// 使用稳定唯一 ID 作为 Bonjour 服务名，避免与系统 mDNS 主机名冲突
function getStableServiceName() {
  let id = localStorage.getItem('eagle-sync-service-id');
  if (!id) {
    id = crypto.randomBytes(4).toString('hex');
    localStorage.setItem('eagle-sync-service-id', id);
  }
  // 使用固定前缀 + 随机 ID，不使用 os.hostname()
  return `EagleSync-${id}`;
}

// 获取显示用的设备名（不用于 Bonjour 注册）
function getDisplayName() {
  return os.hostname().replace(/\.local$/, '');
}

// ============================================================
// Eagle 插件生命周期
// ============================================================
eagle.onPluginCreate(async (plugin) => {
  console.log('Eagle同步器 已加载', plugin.manifest.name);
  STATE.localIP = getLocalIP();
  document.getElementById('localIP').textContent = STATE.localIP;
  document.getElementById('deviceName').textContent = getDisplayName();

  // 获取 Eagle 库路径
  try {
    STATE.libraryPath = eagle.library.path || '';
    document.getElementById('libPathText').textContent = STATE.libraryPath || '未检测到';
  } catch (e) {
    console.warn('获取库路径失败', e);
  }
});

eagle.onPluginBeforeExit(() => {
  cleanup();
});

// ============================================================
// 网络工具
// ============================================================
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function fileHash(filePath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) return resolve(null);
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', d => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ============================================================
// 模式切换
// ============================================================
function setMode(mode) {
  cleanup();
  STATE.mode = mode;

  // UI
  document.getElementById('btnHost').classList.toggle('active', mode === 'host');
  document.getElementById('btnClient').classList.toggle('active', mode === 'client');
  document.getElementById('deviceInfo').style.display = 'flex';
  document.getElementById('libraryPath').style.display = 'flex';
  document.getElementById('footer').style.display = 'block';
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('connectArea').style.display = mode === 'client' ? 'block' : 'none';
  document.getElementById('targetFolderArea').style.display = mode === 'client' ? 'block' : 'none';
  document.getElementById('syncDirection').textContent = mode === 'host' ? '↑ 发送' : '↓ 接收';
  document.getElementById('syncBtnText').textContent = mode === 'host' ? '开始共享' : '开始同步';

  // 主机模式：显示文件夹树 + 多选工具栏
  // 客户端模式：隐藏多选树，只用目标文件夹下拉框
  document.getElementById('treeToolbar').style.display = mode === 'host' ? 'flex' : 'none';
  document.getElementById('treeContainer').style.display = mode === 'host' ? '' : 'none';

  if (mode === 'host') {
    startHostMode();
    loadFolderTree();
  } else {
    startClientMode();
    // 客户端模式显示提示信息
    document.getElementById('treeContainer').style.display = '';
    document.getElementById('treeContainer').innerHTML = `
      <div class="empty-state">
        <div class="emoji">📡</div>
        <div><b>连接主机后开始同步</b></div>
        <p>上方选择"同步到"的目标文件夹，连接主机后点击开始同步</p>
      </div>`;
  }
}

// ============================================================
// 主机模式
// ============================================================
async function startHostMode() {
  setStatus('searching', '启动中...');

  // 创建 HTTP 服务器
  STATE.server = http.createServer(handleHostRequest);
  STATE.server.listen(STATE.port, '0.0.0.0', () => {
    document.getElementById('localPort').textContent = STATE.port;
    log(`服务器启动 → ${STATE.localIP}:${STATE.port}`, 'info');
    setStatus('online', '等待连接');
  });

  STATE.server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      STATE.port++;
      STATE.server.listen(STATE.port, '0.0.0.0');
    }
  });

  // 广播 Bonjour 服务 - 使用稳定 ID，不影响系统主机名
  try {
    STATE.bonjour = new Bonjour();
    const svcName = getStableServiceName();
    STATE.bonjourService = STATE.bonjour.publish({
      name: svcName,
      type: SERVICE_TYPE,
      port: STATE.port,
      host: svcName + '.local',
      txt: {
        libraryPath: STATE.libraryPath,
        displayName: getDisplayName(),
      }
    });
    log('Bonjour 服务已广播', 'success');
  } catch (e) {
    log('Bonjour 广播失败: ' + e.message, 'error');
  }
}

function handleHostRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const url = new URL(req.url, `http://${req.headers.host}`);

  // GET /api/manifest - 获取选中的文件夹树和文件清单
  if (url.pathname === '/api/manifest') {
    buildManifest().then(manifest => {
      res.end(JSON.stringify(manifest));
    }).catch(err => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  // GET /api/folders - 获取全部文件夹结构
  if (url.pathname === '/api/folders') {
    res.end(JSON.stringify(STATE.folders));
    return;
  }

  // GET /api/file?itemId=xxx - 下载文件
  if (url.pathname === '/api/file') {
    const itemId = url.searchParams.get('itemId');
    serveFile(itemId, res);
    return;
  }

  // GET /api/thumbnail?itemId=xxx - 下载缩略图
  if (url.pathname === '/api/thumbnail') {
    const itemId = url.searchParams.get('itemId');
    serveThumbnail(itemId, res);
    return;
  }

  // GET /api/metadata?itemId=xxx - 下载元数据
  if (url.pathname === '/api/metadata') {
    const itemId = url.searchParams.get('itemId');
    serveMetadata(itemId, res);
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'Not found' }));
}

// 构建清单 - 保留文件夹树层级结构
async function buildManifest() {
  const selectedIds = Array.from(STATE.selectedFolderIds);
  if (selectedIds.length === 0) return { folderTree: [], items: [] };
  const selectedFolderDepthMap = buildSelectedFolderDepthMap(STATE.folders, STATE.selectedFolderIds);

  // 找出根文件夹（被选中但其父级未被选中的文件夹）
  const rootFolderIds = [];
  for (const id of selectedIds) {
    const parent = findParent(STATE.folders, id);
    if (!parent || !STATE.selectedFolderIds.has(parent.id)) {
      rootFolderIds.push(id);
    }
  }

  // 构建选中的文件夹子树（保留层级）
  const folderTree = [];
  for (const rootId of rootFolderIds) {
    const node = findNode(STATE.folders, rootId);
    if (node) {
      folderTree.push(buildSelectedSubtree(node));
    }
  }

  // 收集所有选中文件夹下的文件，记录每个文件的来源文件夹
  const items = [];
  const itemIdSet = new Set();
  for (const fid of selectedIds) {
    try {
      const folderItems = await eagle.item.get({ folders: [fid] });
      for (const item of folderItems) {
        if (!itemIdSet.has(item.id)) {
          itemIdSet.add(item.id);
          const sourceFolderId = resolveSourceFolderId(item.folders, fid, selectedFolderDepthMap);
          items.push({
            id: item.id,
            name: item.name,
            ext: item.ext,
            width: item.width || 0,
            height: item.height || 0,
            tags: item.tags || [],
            sourceFolderId,
            url: item.url || '',
            annotation: item.annotation || '',
            star: item.star || 0,
            palettes: item.palettes || [],
            noThumbnail: item.noThumbnail || false,
            modificationTime: item.modificationTime || 0,
            fileSize: item.size || 0,
            hash: await fileHash(item.filePath),
          });
        }
      }
    } catch (e) {
      console.warn('获取文件夹项目失败:', fid, e);
    }
  }

  return { folderTree, items };
}

// 递归构建选中的子树
function buildSelectedSubtree(node) {
  return {
    id: node.id,
    name: node.name,
    description: node.description || '',
    icon: node.icon || '',
    iconColor: node.iconColor || '',
    children: (node.children || [])
      .filter(c => STATE.selectedFolderIds.has(c.id))
      .map(c => buildSelectedSubtree(c)),
  };
}

function buildSelectedFolderDepthMap(nodes, selectedIds, depth = 0, depthMap = new Map()) {
  for (const node of nodes || []) {
    if (selectedIds.has(node.id)) {
      depthMap.set(node.id, depth);
    }
    if (node.children && node.children.length > 0) {
      buildSelectedFolderDepthMap(node.children, selectedIds, depth + 1, depthMap);
    }
  }
  return depthMap;
}

function resolveSourceFolderId(itemFolderIds, fallbackFolderId, depthMap) {
  const matchedFolderIds = (itemFolderIds || []).filter(id => depthMap.has(id));
  if (matchedFolderIds.length === 0) {
    return fallbackFolderId;
  }

  matchedFolderIds.sort((a, b) => depthMap.get(b) - depthMap.get(a));
  return matchedFolderIds[0];
}

async function serveFile(itemId, res) {
  try {
    const item = await eagle.item.getById(itemId);
    const filePath = item.filePath;
    if (!fs.existsSync(filePath)) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'File not found' }));
      return;
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(filePath))}"`);
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function serveThumbnail(itemId, res) {
  try {
    const item = await eagle.item.getById(itemId);
    // Eagle 缩略图通常在 item 目录下的 _thumbnail.png
    const itemDir = path.dirname(item.filePath);
    const thumbPath = path.join(itemDir, '_thumbnail.png');
    if (fs.existsSync(thumbPath)) {
      res.setHeader('Content-Type', 'application/octet-stream');
      fs.createReadStream(thumbPath).pipe(res);
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Thumbnail not found' }));
    }
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function serveMetadata(itemId, res) {
  try {
    const item = await eagle.item.getById(itemId);
    // metadata.json 在 item 的 .info 目录下
    const itemDir = path.dirname(item.filePath);
    const metaPath = path.join(itemDir, 'metadata.json');
    if (fs.existsSync(metaPath)) {
      const data = fs.readFileSync(metaPath, 'utf-8');
      res.end(data);
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Metadata not found' }));
    }
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ============================================================
// 客户端模式
// ============================================================
function startClientMode() {
  setStatus('searching', '搜索设备中...');
  document.getElementById('localPort').textContent = '--';
  document.getElementById('peerList').style.display = 'block';
  document.getElementById('peerList').innerHTML = '<div style="padding:8px;color:var(--text-secondary);font-size:12px;">🔍 正在搜索局域网设备...</div>';

  // 加载本地文件夹列表用于选择目标
  loadTargetFolderOptions();

  // Bonjour 搜索
  try {
    STATE.bonjour = new Bonjour();
    STATE.bonjourBrowser = STATE.bonjour.find({ type: SERVICE_TYPE }, (service) => {
      const peer = {
        name: service.name,
        ip: service.referer?.address || service.addresses?.find(a => !a.includes(':')) || '',
        port: service.port,
        displayName: service.txt?.displayName || service.name,
      };
      if (peer.ip && !STATE.peers.find(p => p.ip === peer.ip && p.port === peer.port)) {
        STATE.peers.push(peer);
        renderPeers();
        log(`发现设备: ${peer.displayName} (${peer.ip}:${peer.port})`, 'success');
      }
    });
  } catch (e) {
    log('Bonjour 搜索失败: ' + e.message, 'error');
  }
}

// 加载本地文件夹到目标选择下拉框
async function loadTargetFolderOptions() {
  try {
    const folders = await eagle.folder.getAll();
    STATE.localFolders = folders;
    const select = document.getElementById('targetFolderSelect');
    select.innerHTML = '<option value="">📁 Eagle 库根目录</option>';
    renderFolderOptions(folders, select, 0);
  } catch (e) {
    console.warn('加载本地文件夹失败', e);
  }
}

function renderFolderOptions(folders, select, depth) {
  for (const f of folders) {
    const option = document.createElement('option');
    option.value = f.id;
    option.textContent = '　'.repeat(depth) + '📁 ' + f.name;
    select.appendChild(option);
    if (f.children && f.children.length > 0) {
      renderFolderOptions(f.children, select, depth + 1);
    }
  }
}

function onTargetFolderChange(value) {
  STATE.targetFolderId = value || null;
  log(`目标文件夹: ${value ? document.getElementById('targetFolderSelect').selectedOptions[0].textContent.trim() : 'Eagle 库根目录'}`, 'info');
}

function renderPeers() {
  const el = document.getElementById('peerList');
  if (STATE.peers.length === 0) {
    el.innerHTML = '<div style="padding:8px;color:var(--text-secondary);font-size:12px;">未发现设备</div>';
    return;
  }
  el.innerHTML = STATE.peers.map((p, i) => `
    <div class="peer-item">
      <div class="peer-name">
        <span class="emoji">💻</span>
        <span>${escapeHtml(p.displayName)}</span>
        <span style="color:var(--text-secondary);font-size:11px">${p.ip}:${p.port}</span>
      </div>
      <button class="btn-small" onclick="connectToPeer(${i})">连接</button>
    </div>
  `).join('');
}

function connectToPeer(index) {
  const peer = STATE.peers[index];
  STATE.connectedHost = { ip: peer.ip, port: peer.port };
  setStatus('online', `已连接 ${peer.displayName}`);
  log(`已连接到 ${peer.displayName} (${peer.ip}:${peer.port})`, 'success');
  document.getElementById('syncBtn').disabled = false;
  loadRemotePreview();
}

function connectToHost() {
  const input = document.getElementById('hostIPInput').value.trim();
  if (!input) return;
  const [ip, port] = input.includes(':') ? input.split(':') : [input, STATE.port];
  STATE.connectedHost = { ip, port: parseInt(port) || STATE.port };
  setStatus('online', `已连接 ${ip}`);
  log(`手动连接到 ${ip}:${port}`, 'success');
  document.getElementById('syncBtn').disabled = false;
  loadRemotePreview();
}

// 客户端连接后，显示主机共享内容的只读预览
async function loadRemotePreview() {
  try {
    const { ip, port } = STATE.connectedHost;
    const data = await httpGet(`http://${ip}:${port}/api/manifest`);
    const manifest = JSON.parse(data);
    const container = document.getElementById('treeContainer');
    container.style.display = '';

    if (!manifest.folderTree || manifest.folderTree.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="emoji">📭</div>
          <div><b>主机未共享任何文件夹</b></div>
          <p>请在主机端选择要共享的文件夹并点击"开始共享"</p>
        </div>`;
      return;
    }

    const folderCount = countTreeNodes(manifest.folderTree);
    const itemCount = manifest.items ? manifest.items.length : 0;

    container.innerHTML = `
      <div class="remote-preview">
        <div class="preview-header">
          <span class="emoji">📦</span>
          <span>主机共享内容预览</span>
        </div>
        <div class="preview-stats">
          ${folderCount} 个文件夹，${itemCount} 个文件
        </div>
        <div class="preview-tree">
          ${manifest.folderTree.map(f => renderPreviewNode(f, 0)).join('')}
        </div>
      </div>`;

    log(`主机共享: ${folderCount} 个文件夹，${itemCount} 个文件`, 'info');
  } catch (e) {
    log('获取主机信息失败: ' + e.message, 'error');
    document.getElementById('treeContainer').innerHTML = `
      <div class="empty-state">
        <div class="emoji">⚠️</div>
        <div><b>连接失败</b></div>
        <p>请确认主机已开启共享模式</p>
      </div>`;
  }
}

function countTreeNodes(nodes) {
  let count = 0;
  for (const n of nodes) {
    count++;
    if (n.children) count += countTreeNodes(n.children);
  }
  return count;
}

function renderPreviewNode(node, depth) {
  const hasChildren = node.children && node.children.length > 0;
  const childrenHTML = hasChildren
    ? node.children.map(c => renderPreviewNode(c, depth + 1)).join('')
    : '';
  return `
    <div class="preview-node" style="padding-left:${12 + depth * 20}px">
      <span class="tree-icon" style="color:#ffca28">📁</span>
      <span class="tree-label">${escapeHtml(node.name)}</span>
    </div>
    ${childrenHTML}`;
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function httpGetBuffer(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// ============================================================
// 同步逻辑
// ============================================================
async function startSync() {
  if (STATE.syncing) return;

  // 主机模式需要选择文件夹，客户端模式只需连接即可
  if (STATE.mode === 'host' && STATE.selectedFolderIds.size === 0) {
    log('请先选择要共享的文件夹', 'error');
    return;
  }
  if (STATE.mode === 'client' && !STATE.connectedHost) {
    log('请先连接主机', 'error');
    return;
  }

  STATE.syncing = true;
  const btn = document.getElementById('syncBtn');
  btn.disabled = true;
  document.getElementById('syncBtnText').textContent = '同步中...';
  showProgress(0);

  try {
    if (STATE.mode === 'host') {
      await hostSync();
    } else {
      await clientSync();
    }
  } catch (e) {
    log('同步失败: ' + e.message, 'error');
  }

  STATE.syncing = false;
  btn.disabled = false;
  document.getElementById('syncBtnText').textContent = STATE.mode === 'host' ? '开始共享' : '开始同步';
}

async function hostSync() {
  log('主机模式：等待客户端拉取...', 'info');
  setStatus('online', '共享中 - 等待客户端');
  const manifest = await buildManifest();
  log(`已准备 ${manifest.items.length} 个文件，${manifest.folderTree.length} 个根文件夹供同步`, 'success');
  showProgress(100);
}

async function clientSync() {
  const { ip, port } = STATE.connectedHost;
  log('正在获取文件清单...', 'info');

  // 1. 获取远程清单（包含文件夹树层级）
  const manifestData = await httpGet(`http://${ip}:${port}/api/manifest`);
  const manifest = JSON.parse(manifestData);

  if (!manifest.folderTree || manifest.folderTree.length === 0) {
    log('远程主机未选择任何文件夹', 'info');
    showProgress(100);
    return;
  }

  if (manifest.items.length === 0) {
    log('远程无可同步文件', 'info');
    showProgress(100);
    return;
  }

  log(`发现 ${manifest.items.length} 个文件，${manifest.folderTree.length} 个根文件夹，开始同步...`, 'info');

  // 2. 按远程树结构创建/复用本地文件夹
  const folderIdMap = {}; // 远程文件夹 ID -> 本地文件夹 ID
  const targetParentId = STATE.targetFolderId || null; // 用户选择的目标母文件夹
  const folderIndex = buildFolderIndex(await eagle.folder.getAll());

  for (const rootNode of manifest.folderTree) {
    await createFoldersNested(rootNode, folderIdMap, folderIndex, targetParentId);
  }
  log(`已创建/映射 ${Object.keys(folderIdMap).length} 个文件夹，并按层级挂载完成`, 'info');
  log(`文件夹映射表: ${JSON.stringify(folderIdMap)}`, 'info');

  // 3. 获取本地已有文件进行比对
  let localItemMap = {};
  try {
    const localItemsRaw = await eagle.item.getAll();
    for (const li of localItemsRaw) {
      localItemMap[li.id] = li;
    }
  } catch (e) {
    console.warn('获取本地文件列表失败', e);
  }

  // 4. 找出需要同步的文件
  const toSync = [];
  for (const remoteItem of manifest.items) {
    const local = localItemMap[remoteItem.id];
    if (!local) {
      toSync.push(remoteItem);
    } else if (remoteItem.modificationTime > (local.modificationTime || 0)) {
      toSync.push({ ...remoteItem, isUpdate: true });
    }
  }

  if (toSync.length === 0) {
    log('所有文件已是最新 ✓', 'success');
    showProgress(100);
    return;
  }

  log(`需同步 ${toSync.length} 个文件`, 'info');

  // 5. 创建临时目录
  const tmpDir = path.join(os.tmpdir(), 'eagle-sync-tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  // 6. 逐个下载和导入
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < toSync.length; i++) {
    const item = toSync[i];
    const progress = Math.round(((i + 1) / toSync.length) * 100);
    showProgress(progress);

    try {
      // 下载文件
      const fileBuffer = await httpGetBuffer(`http://${ip}:${port}/api/file?itemId=${item.id}`);
      const ext = item.ext ? `.${item.ext}` : '';
      const tmpFile = path.join(tmpDir, `${item.id}${ext}`);
      fs.writeFileSync(tmpFile, fileBuffer);

      // 确定目标文件夹：使用清单中记录的来源文件夹映射到的本地文件夹
      const mappedFolderId = item.sourceFolderId ? folderIdMap[item.sourceFolderId] : null;
      if (item.sourceFolderId && !mappedFolderId) {
        log(`跳过 [${item.name}]：源文件夹 ${item.sourceFolderId} 未成功映射到本地`, 'error');
        failCount++;
        try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
        continue;
      }
      const primaryFolderId = mappedFolderId || targetParentId || undefined;
      log(`文件 [${item.name}] 源文件夹=${item.sourceFolderId}, 映射=${mappedFolderId}, 最终目标=${primaryFolderId}`, 'info');

      if (item.isUpdate) {
        // 更新已有文件
        try {
          const localItem = await eagle.item.getById(item.id);
          await localItem.replaceFile(tmpFile);
          // 更新所有元数据
          applyMetadata(localItem, item);
          await localItem.save();
          log(`更新: ${item.name}`, 'info');
        } catch (e) {
          log(`更新失败 [${item.name}]: ${e.message}`, 'error');
          failCount++;
          continue;
        }
      } else {
        // 导入新文件 - 包含完整元数据
        try {
          const addOptions = {
            name: item.name,
            tags: item.tags || [],
            annotation: item.annotation || '',
            website: item.url || '',
          };
          if (primaryFolderId) {
            addOptions.folderId = primaryFolderId;
            addOptions.folders = [primaryFolderId];
          }
          log(`导入选项: ${JSON.stringify(addOptions)}`, 'info');

          // addFromPath 可能返回 item 对象、item ID、或数组
          const result = await eagle.item.addFromPath(tmpFile, addOptions);

          // 尝试设置额外元数据（如 star 星级）
          try {
            let importedItem = null;
            if (result && typeof result === 'object' && typeof result.save === 'function') {
              importedItem = result;
            } else if (result && result.id) {
              importedItem = await eagle.item.getById(result.id);
            } else if (Array.isArray(result) && result.length > 0) {
              const first = result[0];
              importedItem = typeof first === 'string'
                ? await eagle.item.getById(first)
                : first;
            }

            if (importedItem && typeof importedItem.save === 'function') {
              if (item.star) importedItem.star = item.star;
              if (item.url) importedItem.url = item.url;
              // 确保文件在正确的文件夹中
              if (primaryFolderId) {
                const currentFolders = importedItem.folders || [];
                if (!currentFolders.includes(primaryFolderId)) {
                  importedItem.folders = [...currentFolders, primaryFolderId];
                }
              }
              await importedItem.save();
            }
          } catch (metaErr) {
            // 元数据设置失败不影响导入结果
            console.warn('设置额外元数据失败:', metaErr.message);
          }

          log(`导入: ${item.name} → ${primaryFolderId ? '指定文件夹' : '根目录'}`, 'success');
        } catch (e) {
          log(`导入失败 [${item.name}]: ${e.message}`, 'error');
          failCount++;
          continue;
        }
      }

      successCount++;

      // 清理临时文件
      try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }

    } catch (e) {
      log(`同步失败 [${item.name}]: ${e.message}`, 'error');
      failCount++;
    }
  }

  // 清理临时目录
  try { fs.rmdirSync(tmpDir); } catch (e) { /* ignore */ }

  log(`同步完成！成功 ${successCount} 个，失败 ${failCount} 个`, successCount > 0 ? 'success' : 'error');
  showProgress(100);
  setStatus('online', '同步完成');
}

function makeFolderKey(parentId, name) {
  return `${parentId || '__root__'}::${name}`;
}

function buildFolderIndex(folders, parentId = null, index = new Map()) {
  for (const folder of folders || []) {
    const key = makeFolderKey(parentId, folder.name);
    if (!index.has(key)) {
      index.set(key, folder);
    }
    if (folder.children && folder.children.length > 0) {
      buildFolderIndex(folder.children, folder.id, index);
    }
  }
  return index;
}

// 递归按层级创建文件夹；同名复用仅限同一父级，避免串层级
async function createFoldersNested(node, idMap, folderIndex, parentLocalId = null) {
  const folderKey = makeFolderKey(parentLocalId, node.name);
  let localFolder = folderIndex.get(folderKey);

  if (localFolder) {
    log(`文件夹已存在，复用: ${node.name} (${localFolder.id})`, 'info');
  } else {
    try {
      if (parentLocalId) {
        try {
          localFolder = await eagle.folder.createSubfolder(parentLocalId, {
            name: node.name,
            description: node.description || '',
          });
        } catch (_) {
          localFolder = await eagle.folder.create({
            name: node.name,
            description: node.description || '',
            parent: parentLocalId,
          });
        }
      } else {
        localFolder = await eagle.folder.create({
          name: node.name,
          description: node.description || '',
        });
      }
      folderIndex.set(folderKey, localFolder);
      log(`新建文件夹: ${node.name} (${localFolder.id})${parentLocalId ? ` ← 父级 ${parentLocalId}` : ''}`, 'info');
    } catch (e) {
      log(`创建文件夹失败: ${node.name} - ${e.message}`, 'error');
      return;
    }
  }

  idMap[node.id] = localFolder.id;

  if (node.children && node.children.length > 0) {
    for (const child of node.children) {
      await createFoldersNested(child, idMap, folderIndex, localFolder.id);
    }
  }
}

// 将元数据应用到 Eagle item 对象
function applyMetadata(eagleItem, remoteItem) {
  try {
    if (remoteItem.tags && remoteItem.tags.length > 0) {
      eagleItem.tags = remoteItem.tags;
    }
    if (remoteItem.annotation) {
      eagleItem.annotation = remoteItem.annotation;
    }
    if (remoteItem.url) {
      eagleItem.url = remoteItem.url;
    }
    if (remoteItem.star) {
      eagleItem.star = remoteItem.star;
    }
  } catch (e) {
    console.warn('应用元数据时出错:', e);
  }
}

// ============================================================
// 文件夹树 - 加载与渲染
// ============================================================
async function loadFolderTree() {
  try {
    const folders = await eagle.folder.getAll();
    STATE.folders = buildTreeData(folders);
    renderFolderTree(STATE.folders);
  } catch (e) {
    log('加载文件夹失败: ' + e.message, 'error');
  }
}

function buildTreeData(folders) {
  return folders.map(f => folderToNode(f));
}

function folderToNode(f) {
  return {
    id: f.id,
    name: f.name,
    description: f.description || '',
    icon: f.icon || '',
    iconColor: f.iconColor || '',
    children: (f.children || []).map(c => folderToNode(c)),
  };
}

function renderFolderTree(folders) {
  const container = document.getElementById('treeContainer');
  if (!folders || folders.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="emoji">📂</div>
        <div>暂无文件夹</div>
      </div>`;
    return;
  }
  container.innerHTML = folders.map(f => renderTreeNode(f, 0)).join('');
  updateSelectedStats();
}

function renderTreeNode(node, depth) {
  const hasChildren = node.children && node.children.length > 0;
  const isChecked = STATE.selectedFolderIds.has(node.id);
  const isExpanded = depth < 1; // 默认展开第一层

  const colorMap = {
    red: '#f44336', orange: '#ff9800', yellow: '#ffeb3b',
    green: '#4caf50', aqua: '#00bcd4', blue: '#2196f3',
    purple: '#9c27b0', pink: '#e91e63'
  };
  const iconColor = colorMap[(node.iconColor || '').toLowerCase()] || '#ffca28';

  const childrenHTML = hasChildren
    ? `<div class="tree-children${isExpanded ? '' : ' collapsed'}" id="children-${node.id}">
        ${node.children.map(c => renderTreeNode(c, depth + 1)).join('')}
       </div>`
    : '';

  return `
    <div class="tree-node" data-id="${node.id}" data-name="${node.name}">
      <div class="tree-node-row" style="padding-left:${12 + depth * 20}px">
        <button class="tree-toggle ${hasChildren ? (isExpanded ? 'expanded' : '') : 'hidden'}"
                onclick="toggleExpand('${node.id}', this)">▶</button>
        <div class="tree-checkbox ${isChecked ? 'checked' : ''}"
             id="cb-${node.id}"
             onclick="toggleCheck('${node.id}')"></div>
        <span class="tree-icon" style="color:${iconColor}">📁</span>
        <span class="tree-label">${escapeHtml(node.name)}</span>
        ${hasChildren ? `<span class="tree-count">${countDescendants(node)} 项</span>` : ''}
      </div>
      ${childrenHTML}
    </div>`;
}

function countDescendants(node) {
  let count = 0;
  if (node.children) {
    count += node.children.length;
    for (const c of node.children) {
      count += countDescendants(c);
    }
  }
  return count;
}

// ============================================================
// 树操作
// ============================================================
function toggleExpand(id, btn) {
  const children = document.getElementById(`children-${id}`);
  if (!children) return;
  const collapsed = children.classList.toggle('collapsed');
  btn.classList.toggle('expanded', !collapsed);
}

function toggleCheck(id) {
  const cb = document.getElementById(`cb-${id}`);
  if (!cb) return;

  if (STATE.selectedFolderIds.has(id)) {
    STATE.selectedFolderIds.delete(id);
    cb.classList.remove('checked');
    uncheckChildren(id);
  } else {
    STATE.selectedFolderIds.add(id);
    cb.classList.add('checked');
    checkChildren(id);
  }

  updateParentState(id);
  updateSelectedStats();

  const btn = document.getElementById('syncBtn');
  if (STATE.mode === 'host') {
    btn.disabled = STATE.selectedFolderIds.size === 0;
  } else {
    btn.disabled = STATE.selectedFolderIds.size === 0 || !STATE.connectedHost;
  }
}

function checkChildren(id) {
  const node = findNode(STATE.folders, id);
  if (!node || !node.children) return;
  for (const child of node.children) {
    STATE.selectedFolderIds.add(child.id);
    const cb = document.getElementById(`cb-${child.id}`);
    if (cb) { cb.classList.add('checked'); cb.classList.remove('partial'); }
    checkChildren(child.id);
  }
}

function uncheckChildren(id) {
  const node = findNode(STATE.folders, id);
  if (!node || !node.children) return;
  for (const child of node.children) {
    STATE.selectedFolderIds.delete(child.id);
    const cb = document.getElementById(`cb-${child.id}`);
    if (cb) { cb.classList.remove('checked', 'partial'); }
    uncheckChildren(child.id);
  }
}

function updateParentState(childId) {
  const parent = findParent(STATE.folders, childId);
  if (!parent) return;

  const allChildren = getAllDescendantIds(parent);
  const checkedCount = allChildren.filter(id => STATE.selectedFolderIds.has(id)).length;
  const cb = document.getElementById(`cb-${parent.id}`);
  if (!cb) return;

  cb.classList.remove('checked', 'partial');
  if (checkedCount === allChildren.length && checkedCount > 0) {
    cb.classList.add('checked');
    STATE.selectedFolderIds.add(parent.id);
  } else if (checkedCount > 0) {
    cb.classList.add('partial');
  } else {
    STATE.selectedFolderIds.delete(parent.id);
  }

  updateParentState(parent.id);
}

function findNode(nodes, id) {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children) {
      const found = findNode(n.children, id);
      if (found) return found;
    }
  }
  return null;
}

function findParent(nodes, childId, parent = null) {
  for (const n of nodes) {
    if (n.id === childId) return parent;
    if (n.children) {
      const found = findParent(n.children, childId, n);
      if (found) return found;
    }
  }
  return null;
}

function getAllDescendantIds(node) {
  const ids = [];
  if (node.children) {
    for (const c of node.children) {
      ids.push(c.id);
      ids.push(...getAllDescendantIds(c));
    }
  }
  return ids;
}

function toggleSelectAll() {
  STATE.allSelected = !STATE.allSelected;
  const allIds = [];
  function collect(nodes) {
    for (const n of nodes) {
      allIds.push(n.id);
      if (n.children) collect(n.children);
    }
  }
  collect(STATE.folders);

  if (STATE.allSelected) {
    allIds.forEach(id => STATE.selectedFolderIds.add(id));
  } else {
    STATE.selectedFolderIds.clear();
  }

  allIds.forEach(id => {
    const cb = document.getElementById(`cb-${id}`);
    if (cb) {
      cb.classList.toggle('checked', STATE.allSelected);
      cb.classList.remove('partial');
    }
  });

  updateSelectedStats();
  document.getElementById('syncBtn').disabled = STATE.selectedFolderIds.size === 0;
}

function collapseAll() {
  document.querySelectorAll('.tree-children').forEach(el => el.classList.add('collapsed'));
  document.querySelectorAll('.tree-toggle').forEach(el => el.classList.remove('expanded'));
}

function filterTree(query) {
  query = query.toLowerCase();
  document.querySelectorAll('.tree-node').forEach(node => {
    const name = (node.dataset.name || '').toLowerCase();
    if (!query || name.includes(query)) {
      node.style.display = '';
    } else {
      const hasMatch = Array.from(node.querySelectorAll('.tree-node')).some(
        child => (child.dataset.name || '').toLowerCase().includes(query)
      );
      node.style.display = hasMatch ? '' : 'none';
    }
  });

  if (query) {
    document.querySelectorAll('.tree-children').forEach(el => el.classList.remove('collapsed'));
    document.querySelectorAll('.tree-toggle').forEach(el => el.classList.add('expanded'));
  }
}

// ============================================================
// UI 辅助
// ============================================================
function setStatus(type, text) {
  const dot = document.getElementById('statusDot');
  const label = document.getElementById('statusText');
  dot.className = 'status-dot ' + (type || '');
  label.textContent = text;
}

function updateSelectedStats() {
  const count = STATE.selectedFolderIds.size;
  document.getElementById('selectedStats').textContent = `已选择 ${count} 个文件夹`;
}

function showProgress(pct) {
  const bar = document.getElementById('progressBar');
  const fill = document.getElementById('progressFill');
  bar.classList.add('active');
  fill.style.width = pct + '%';
  if (pct >= 100) {
    setTimeout(() => bar.classList.remove('active'), 2000);
  }
}

function log(msg, type = '') {
  const panel = document.getElementById('logPanel');
  panel.classList.add('active');
  const entry = document.createElement('div');
  entry.className = 'log-entry ' + type;
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  entry.textContent = `[${time}] ${msg}`;
  panel.appendChild(entry);
  panel.scrollTop = panel.scrollHeight;
  console.log(`[Sync ${type}] ${msg}`);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================
// 清理
// ============================================================
function cleanup() {
  if (STATE.server) {
    STATE.server.close();
    STATE.server = null;
  }
  if (STATE.bonjourService) {
    try { STATE.bonjourService.stop(); } catch (e) {}
    STATE.bonjourService = null;
  }
  if (STATE.bonjourBrowser) {
    try { STATE.bonjourBrowser.stop(); } catch (e) {}
    STATE.bonjourBrowser = null;
  }
  if (STATE.bonjour) {
    try { STATE.bonjour.destroy(); } catch (e) {}
    STATE.bonjour = null;
  }
  STATE.peers = [];
  STATE.connectedHost = null;
  STATE.selectedFolderIds.clear();
  STATE.targetFolderId = null;
}
