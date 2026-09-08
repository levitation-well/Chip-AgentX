import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const outDir = path.resolve('public/demos');
const assetDir = path.join(outDir, 'assets');

const styles = [
  ['01', 'claude', 'Claude', 'ai-ml', 'Warm editorial console', '#f7f0e8', '#fffaf3', '#e4d6c6', '#2d2219', '#7a6b5b', '#c15f3c', '#fff', 'Source Sans 3', 'editorial'],
  ['02', 'cohere', 'Cohere', 'ai-ml', 'Vibrant data intelligence dashboard', '#071311', '#10201d', '#1e3b35', '#f4fbf8', '#8fb2a8', '#2de2a5', '#071311', 'Inter', 'cohere'],
  ['03', 'elevenlabs', 'ElevenLabs', 'ai-ml', 'Cinematic audio studio', '#000000', '#0a0a0a', '#27272a', '#fafafa', '#71717a', '#e11d48', '#fff', 'Inter', 'cinematic'],
  ['04', 'minimax', 'Minimax', 'ai-ml', 'Neon agent terminal', '#0b0f1a', '#141b2d', '#1e2d4a', '#ffffff', '#94a3b8', '#00d4aa', '#0a0a0a', 'Inter', 'neon'],
  ['05', 'mistralai', 'Mistral AI', 'ai-ml', 'French minimal intelligence', '#1e1e2e', '#282a3a', '#3d3f5c', '#ffffff', '#a6adc8', '#9b59b6', '#fff', 'Inter', 'technical'],
  ['06', 'ollama', 'Ollama', 'ai-ml', 'Local terminal simplicity', '#1a1a1a', '#242424', '#3f3f46', '#e4e4e7', '#71717a', '#16a34a', '#fff', 'JetBrains Mono', 'mono'],
  ['07', 'opencodeai', 'OpenCode AI', 'ai-ml', 'Developer dark IDE', '#09090b', '#18181b', '#27272a', '#fafafa', '#a1a1aa', '#3b82f6', '#fff', 'JetBrains Mono', 'mono'],
  ['08', 'replicate', 'Replicate', 'ai-ml', 'Clean code canvas', '#fafafa', '#ffffff', '#e5e7eb', '#1a1a1a', '#6b7280', '#2563eb', '#fff', 'Inter', 'code-light'],
  ['09', 'runwayml', 'RunwayML', 'ai-ml', 'Media command room', '#000000', '#111111', '#2a2a2a', '#ffffff', '#888888', '#6c63ff', '#fff', 'Inter', 'cinematic'],
  ['10', 'togetherai', 'Together AI', 'ai-ml', 'Blueprint compute grid', '#0b1426', '#111d35', '#1e3a5f', '#ffffff', '#8b9bb4', '#4f9bf5', '#fff', 'IBM Plex Sans', 'blueprint'],
  ['11', 'voltagent', 'VoltAgent', 'ai-ml', 'Void green terminal', '#0a0f0a', '#111a11', '#166534', '#f0fdf4', '#86efac', '#22c55e', '#fff', 'JetBrains Mono', 'terminal'],
  ['12', 'xai', 'xAI', 'ai-ml', 'Stark monochrome future', '#000000', '#050505', '#2a2a2a', '#ffffff', '#7a7a7a', '#ffffff', '#000', 'IBM Plex Mono', 'xai'],
  ['13', 'cursor', 'Cursor', 'ai-ml', 'Sleek coding surface', '#0a0a0b', '#111113', '#2a2a30', '#e8e8ed', '#7c7c85', '#7c3aed', '#fff', 'Inter', 'developer'],
  ['14', 'expo', 'Expo', 'devtools', 'Dark mobile dev kit', '#000000', '#1c1c1e', '#38383a', '#ffffff', '#8e8e93', '#007aff', '#fff', 'Inter', 'developer'],
  ['15', 'linear', 'Linear', 'devtools', 'Precise issue cockpit', '#ffffff', '#fafafa', '#e5e7eb', '#1a1a1a', '#6b7280', '#5e6ad2', '#fff', 'Inter', 'precision'],
  ['16', 'lovable', 'Lovable', 'devtools', 'Friendly builder studio', '#fff7ed', '#ffffff', '#e7e5e4', '#1c1917', '#78716c', '#f97316', '#fff', 'DM Sans', 'playful'],
  ['17', 'mintlify', 'Mintlify', 'devtools', 'Readable docs control', '#fafcfc', '#ffffff', '#e2e8f0', '#0f172a', '#64748b', '#10b981', '#fff', 'Inter', 'docs'],
  ['18', 'posthog', 'PostHog', 'devtools', 'Product analytics lab', '#1a1a2e', '#252541', '#3a3a5c', '#ffffff', '#9090b0', '#ff5722', '#fff', 'Inter', 'playful-dark'],
  ['19', 'raycast', 'Raycast', 'devtools', 'Command palette noir', '#1c1c1e', '#2c2c2e', '#48484a', '#ffffff', '#8e8e93', '#ff6363', '#fff', 'Inter', 'command'],
  ['20', 'resend', 'Resend', 'devtools', 'Minimal mail console', '#000000', '#111111', '#222222', '#ffffff', '#666666', '#ffffff', '#000', 'Geist', 'mono'],
  ['21', 'sentry', 'Sentry', 'devtools', 'Incident dashboard', '#1e1e2e', '#252539', '#3d3d5c', '#ffffff', '#a0a0c0', '#fa584c', '#fff', 'Rubik', 'dashboard'],
  ['22', 'supabase', 'Supabase', 'devtools', 'Emerald database shell', '#0a0a0b', '#191a1f', '#2e2e38', '#ffffff', '#7f849c', '#3ecf8e', '#0a0a0a', 'Inter', 'developer'],
  ['23', 'superhuman', 'Superhuman', 'devtools', 'Premium keyboard UI', '#fafafa', '#ffffff', '#e5e7eb', '#1a1a1a', '#6b7280', '#6b5ce7', '#fff', 'Inter', 'premium'],
  ['24', 'vercel', 'Vercel', 'devtools', 'Black white precision', '#000000', '#0a0a0a', '#1a1a1a', '#ffffff', '#666666', '#ffffff', '#000', 'Geist', 'precision-dark'],
  ['25', 'warp', 'Warp', 'devtools', 'Block terminal IDE', '#0d1117', '#161b22', '#30363d', '#e6edf3', '#7d8590', '#2ecc71', '#fff', 'JetBrains Mono', 'terminal'],
  ['26', 'zapier', 'Zapier', 'devtools', 'Warm automation board', '#f8f5f2', '#ffffff', '#e5e0da', '#1a1a1a', '#6b7280', '#ff4a00', '#fff', 'Inter', 'friendly'],
  ['27', 'clickhouse', 'ClickHouse', 'infra', 'Yellow technical docs', '#f0f0f0', '#ffffff', '#e0e0e0', '#1a1a1a', '#6b7280', '#ffcc00', '#1a1a1a', 'Inter', 'docs'],
  ['28', 'composio', 'Composio', 'infra', 'Integration graph dark', '#09090b', '#18181b', '#27272a', '#fafafa', '#a1a1aa', '#8b5cf6', '#fff', 'Inter', 'integrations'],
  ['29', 'hashicorp', 'HashiCorp', 'infra', 'Enterprise infrastructure', '#ffffff', '#fafafa', '#e1e3e6', '#1a1a1a', '#5b6169', '#60b5e4', '#fff', 'Inter', 'enterprise'],
  ['30', 'mongodb', 'MongoDB', 'infra', 'Green docs database', '#ffffff', '#f7f7f7', '#e0e0e0', '#1f1f1f', '#6b7280', '#00ed64', '#1f1f1f', 'Inter', 'docs'],
  ['31', 'sanity', 'Sanity', 'infra', 'Editorial content ops', '#f5f5f4', '#ffffff', '#e7e5e4', '#1c1917', '#78716c', '#e63946', '#fff', 'Space Grotesk', 'editorial'],
  ['32', 'stripe', 'Stripe', 'infra', 'Gradient fintech ops', '#f6f9fc', '#ffffff', '#d8dee6', '#1a1a2e', '#5b6572', '#635bff', '#fff', 'Source Sans 3', 'gradient'],
  ['33', 'airtable', 'Airtable', 'infra', 'Structured data board', '#ffffff', '#f7f8fa', '#e3e5e8', '#1f2328', '#6b7785', '#18b4e0', '#fff', 'Inter', 'structured'],
  ['34', 'cal', 'Cal.com', 'infra', 'Neutral scheduling OS', '#fafafa', '#ffffff', '#e5e7eb', '#1a1a1a', '#6b7280', '#111827', '#fff', 'Inter', 'minimal'],
  ['35', 'clay', 'Clay', 'design', 'Soft organic CRM', '#f5f2ed', '#fdfcfa', '#e8e4df', '#1a1a1a', '#6b7280', '#c4a47c', '#fff', 'DM Sans', 'organic'],
  ['36', 'figma', 'Figma', 'design', 'Multicolor design board', '#000000', '#0d0d0d', '#1f1f1f', '#ffffff', '#8c8c8c', '#a259ff', '#fff', 'Inter', 'creative'],
  ['37', 'framer', 'Framer', 'design', 'Motion first canvas', '#0a0a0a', '#111111', '#222222', '#ffffff', '#888888', '#0099ff', '#fff', 'Inter', 'motion'],
  ['38', 'intercom', 'Intercom', 'design', 'Conversational support UI', '#1f1f1f', '#2a2a2a', '#3d3d3d', '#ffffff', '#a0a0a0', '#1f8ded', '#fff', 'Inter', 'conversation'],
  ['39', 'miro', 'Miro', 'design', 'Infinite canvas yellow', '#ffeaa7', '#ffffff', '#f0dfa0', '#1a1a1a', '#6b7280', '#050038', '#fff', 'Inter', 'canvas'],
  ['40', 'notion', 'Notion', 'design', 'Warm document workspace', '#ffffff', '#f7f6f3', '#e9e9e6', '#37352f', '#9b9a97', '#1a1a1a', '#fff', 'Lora', 'document'],
  ['41', 'pinterest', 'Pinterest', 'design', 'Masonry idea board', '#ffffff', '#fafafa', '#efefef', '#111111', '#6b7280', '#e60023', '#fff', 'DM Sans', 'masonry'],
  ['42', 'webflow', 'Webflow', 'design', 'Polished site builder', '#ffffff', '#f5f5f5', '#e0e0e0', '#333333', '#757575', '#4353ff', '#fff', 'Inter', 'builder'],
  ['43', 'coinbase', 'Coinbase', 'fintech', 'Institutional blue trust', '#0052ff', '#ffffff', '#dbeafe', '#1a1a1a', '#475569', '#0052ff', '#fff', 'DM Sans', 'trust'],
  ['44', 'kraken', 'Kraken', 'fintech', 'Crypto dense dashboard', '#0d1117', '#161b22', '#30363d', '#e6edf3', '#7d8590', '#5741d9', '#fff', 'Inter', 'dashboard'],
  ['45', 'revolut', 'Revolut', 'fintech', 'Sleek gradient finance', '#000000', '#111111', '#222222', '#ffffff', '#888888', '#8b5cf6', '#fff', 'Inter', 'premium-dark'],
  ['46', 'wise', 'Wise', 'fintech', 'Clear green transfers', '#ffffff', '#f7f9fc', '#e1e4e8', '#1a1a1a', '#6b7280', '#00c2a0', '#fff', 'Inter', 'friendly'],
  ['47', 'airbnb', 'Airbnb', 'enterprise', 'Warm coral marketplace', '#ffffff', '#f7f7f7', '#dddddd', '#222222', '#717171', '#ff385c', '#fff', 'DM Sans', 'warm'],
  ['48', 'apple', 'Apple', 'enterprise', 'Premium white space', '#ffffff', '#f5f5f7', '#d2d2d7', '#1d1d1f', '#6e6e73', '#0071e3', '#fff', 'Inter', 'premium'],
  ['49', 'bmw', 'BMW', 'enterprise', 'Dark precision engineering', '#1a1a1a', '#262626', '#333333', '#ffffff', '#999999', '#0066b1', '#fff', 'IBM Plex Sans', 'engineering'],
  ['50', 'ibm', 'IBM', 'enterprise', 'Carbon structured blue', '#ffffff', '#f4f4f4', '#dfe3e6', '#171c1e', '#5a6872', '#0f62fe', '#fff', 'IBM Plex Sans', 'carbon'],
  ['51', 'nvidia', 'NVIDIA', 'enterprise', 'Green compute power', '#000000', '#0b0b0b', '#1f1f1f', '#ffffff', '#888888', '#76b900', '#000', 'Inter', 'compute'],
  ['52', 'spacex', 'SpaceX', 'enterprise', 'Stark mission control', '#000000', '#121212', '#1e1e1e', '#ffffff', '#8e8e8e', '#ffffff', '#000', 'Inter', 'mission'],
  ['53', 'spotify', 'Spotify', 'enterprise', 'Bold media dark', '#000000', '#121212', '#1f1f1f', '#ffffff', '#b3b3b3', '#1db954', '#000', 'DM Sans', 'media'],
  ['54', 'uber', 'Uber', 'enterprise', 'Urban black and white', '#f7f7f7', '#ffffff', '#e0e0e0', '#1d1d1d', '#6b7280', '#000000', '#fff', 'DM Sans', 'urban'],
  ['55', 'glasscn', 'glasscn-ui', 'react', 'Cyan violet glassmorphism', '#0f172a', '#1e293b', '#334155', '#ffffff', '#94a3b8', '#22d3ee', '#0f172a', 'Inter', 'glass'],
].map(([id, slug, name, category, tagline, bg, surface, border, text, muted, accent, accentText, font, mood]) => ({
  id, slug, name, category, tagline, bg, surface, border, text, muted, accent, accentText, font, mood,
  file: `${id}-${slug}.html`,
}));

const categories = [
  ['all', '全部'],
  ['ai-ml', 'AI / ML'],
  ['devtools', 'Developer'],
  ['infra', 'Infra'],
  ['design', 'Design'],
  ['fintech', 'Fintech'],
  ['enterprise', 'Enterprise'],
  ['react', 'React'],
];

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function fontHref(font) {
  const families = {
    'Source Sans 3': 'Source+Sans+3:wght@400;500;600;700;800;900',
    Inter: 'Inter:wght@400;500;600;700;800;900',
    'JetBrains Mono': 'JetBrains+Mono:wght@400;500;600;700;800',
    'IBM Plex Sans': 'IBM+Plex+Sans:wght@400;500;600;700;800',
    'IBM Plex Mono': 'IBM+Plex+Mono:wght@400;500;600;700',
    Geist: 'Geist:wght@400;500;600;700;800',
    'DM Sans': 'DM+Sans:wght@400;500;600;700;800;900',
    Rubik: 'Rubik:wght@400;500;600;700;800',
    'Space Grotesk': 'Space+Grotesk:wght@400;500;600;700',
    Lora: 'Lora:wght@400;500;600;700',
  };
  return `https://fonts.googleapis.com/css2?family=${families[font] || families.Inter}&display=swap`;
}

function styleVars(style) {
  return [
    `--bg:${style.bg}`,
    `--surface:${style.surface}`,
    `--border:${style.border}`,
    `--text:${style.text}`,
    `--muted:${style.muted}`,
    `--accent:${style.accent}`,
    `--accent-text:${style.accentText}`,
    `--font:'${style.font}'`,
  ].join(';');
}

function demoPage(style) {
  const label = `${style.id} · ${style.name}`;
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>AgentX ${escapeHtml(label)} WebUI Demo</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="stylesheet" href="${fontHref(style.font)}">
    <link rel="stylesheet" href="assets/demo-shell.css">
    <style>:root{${styleVars(style)}}</style>
  </head>
  <body class="style-demo" data-mood="${escapeHtml(style.mood)}">
    <div class="demo-bg" aria-hidden="true"></div>
    <div class="demo-shell">
      <header class="demo-topbar">
        <a class="demo-brand" href="index.html" aria-label="返回风格总览">
          <span class="demo-brand-mark">AX</span>
          <span>
            <strong>AgentX</strong>
            <small>${escapeHtml(label)} / ${escapeHtml(style.tagline)}</small>
          </span>
        </a>
        <nav class="demo-tabs" role="tablist" aria-label="Demo screens">
          <button class="demo-tab active" id="tab-home" role="tab" aria-selected="true" type="button" data-screen="home">首页</button>
          <button class="demo-tab" id="tab-login" role="tab" aria-selected="false" type="button" data-screen="login">登录</button>
          <button class="demo-tab" id="tab-chat" role="tab" aria-selected="false" type="button" data-screen="chat">聊天</button>
          <button class="demo-tab" id="tab-admin" role="tab" aria-selected="false" type="button" data-screen="admin">Admin</button>
          <button class="demo-tab" id="tab-mcp" role="tab" aria-selected="false" type="button" data-screen="mcp">MCP 接入</button>
        </nav>
      </header>

      <main class="demo-stage">
        <section class="demo-screen active" role="tabpanel" aria-labelledby="tab-home" data-screen-panel="home" aria-label="首页预览">
          <div class="hero-grid">
            <div class="hero-copy">
              <p class="eyebrow">多智能体编排 · 受控知识库访问 · Remote MCP 接入</p>
              <h1>${escapeHtml(style.name)} Style</h1>
              <p class="lead">把 AgentX 放进 ${escapeHtml(style.tagline)} 的视觉语言里，快速判断最终产品 WebUI 的方向。</p>
              <div class="action-row">
                <button class="primary-action" type="button" data-jump="chat">进入工作台</button>
                <button class="ghost-action" type="button" data-jump="mcp">客户 MCP 接入</button>
                <button class="ghost-action" type="button" data-jump="login">登录预览</button>
              </div>
            </div>
            <aside class="hero-orbit" aria-label="AgentX 状态概览">
              <div class="metric-card primary-metric">
                <span>Live sessions</span>
                <strong>12</strong>
                <em>3 个芯片知识库在线</em>
              </div>
              <div class="metric-card">
                <span>Audit ready</span>
                <strong>98%</strong>
                <em>会话、密钥、问题台账可追踪</em>
              </div>
              <div class="metric-card">
                <span>Remote MCP</span>
                <strong>ON</strong>
                <em>客户只看到授权资源</em>
              </div>
            </aside>
          </div>
          <div class="feature-grid">
            <article><span>01</span><h3>多智能体会话</h3><p>统一 Web 和 MCP 入口，保留会话、日志和历史上下文。</p></article>
            <article><span>02</span><h3>芯片资料问答</h3><p>围绕 chip access、角色提示词和受控知识库访问。</p></article>
            <article><span>03</span><h3>权限和审计</h3><p>用户、MCP KEY、会话历史和问题台账集中治理。</p></article>
            <article><span>04</span><h3>Remote MCP</h3><p>通过公开 endpoint 连接外部客户端，不暴露工作目录。</p></article>
          </div>
          <div class="dashboard-strip">
            <div class="chart-card"><span>session throughput</span><i style="--h:62%"></i><i style="--h:46%"></i><i style="--h:76%"></i><i style="--h:54%"></i><i style="--h:88%"></i></div>
            <div class="chart-card"><span>token latency</span><strong>218ms</strong><em>-14% this hour</em></div>
            <div class="chart-card"><span>resource usage</span><strong>73%</strong><em>3 chip workspaces active</em></div>
          </div>
        </section>

        <section class="demo-screen" hidden aria-hidden="true" role="tabpanel" aria-labelledby="tab-login" data-screen-panel="login" aria-label="登录界面预览">
          <div class="login-preview">
            <aside class="login-art">
              <span class="eyebrow">Secure workspace</span>
              <h2>让团队和客户进入各自的 AgentX 边界。</h2>
              <p>登录后自动按角色展示工作台、Admin 或客户 MCP 指引。</p>
              <div class="security-stack">
                <span>JWT session</span><span>Role policy</span><span>Chip access</span>
              </div>
            </aside>
            <form class="mock-form">
              <div class="form-brand"><span class="demo-brand-mark">AX</span><strong>登录 AgentX</strong></div>
              <label>账号<input value="demo.admin" aria-label="账号"></label>
              <label>密码<input type="password" value="agentx-demo" aria-label="密码"></label>
              <button class="primary-action loading-action" type="button">登录中</button>
              <p class="form-error">模拟状态：账号或密码不正确时会在这里提示。</p>
            </form>
          </div>
        </section>

        <section class="demo-screen" hidden aria-hidden="true" role="tabpanel" aria-labelledby="tab-chat" data-screen-panel="chat" aria-label="聊天界面预览">
          <div class="chat-preview">
            <aside class="chat-sidebar">
              <div class="section-head"><h2>会话</h2><button type="button">新会话</button></div>
              <button class="session-row active" type="button"><strong>E521.39</strong><span>LIN 驱动调试 / running</span></button>
              <button class="session-row" type="button"><strong>E522.95</strong><span>寄存器说明 / history</span></button>
              <button class="session-row" type="button"><strong>Remote MCP</strong><span>客户 smoke test / done</span></button>
              <div class="mini-panel">
                <span>Product</span>
                <strong>AgentX v1.6</strong>
                <p>Powered by controlled chip workspace.</p>
              </div>
            </aside>
            <section class="chat-main">
              <div class="chat-toolbar">
                <label>芯片 <select><option>E521.39 demo chip</option></select></label>
                <span class="status-pill">admin / online</span>
                <button type="button">反馈</button>
              </div>
              <div class="message-list">
                <div class="message assistant"><span>已载入 E521.39 资料。你想先看通信初始化还是故障复现？</span></div>
                <div class="message user"><span>帮我确认 autobaud 恢复流程的边界条件。</span></div>
                <div class="message assistant streaming"><span>我会按 datasheet、现有代码路径和测试日志拆成三段检查...</span></div>
              </div>
              <div class="composer">
                <textarea rows="3">输入消息，模拟发送状态...</textarea>
                <button class="primary-action" type="button">发送</button>
              </div>
            </section>
          </div>
        </section>

        <section class="demo-screen" hidden aria-hidden="true" role="tabpanel" aria-labelledby="tab-admin" data-screen-panel="admin" aria-label="Admin 界面预览">
          <div class="admin-preview">
            <nav class="admin-nav">
              <a class="active">用户管理</a><a>角色管理</a><a>提示词</a><a>芯片映射</a><a>会话历史</a><a>问题台账</a><a>反馈管理</a>
            </nav>
            <section class="admin-workbench">
              <div class="admin-column">
                <div class="section-head"><h2>用户</h2><button type="button">创建用户</button></div>
                <div class="user-row active"><strong>root</strong><span>admin · active · 2 keys</span></div>
                <div class="user-row"><strong>customer-a</strong><span>customer · E521.39 · 1 key</span></div>
                <div class="user-row"><strong>field-team</strong><span>internal · all chips</span></div>
              </div>
              <div class="admin-detail">
                <div class="detail-banner">
                  <span>Selected user</span>
                  <h2>root / admin</h2>
                  <p>Sensitive credential：完整 MCP KEY 只在本地 Admin 页面显示。</p>
                </div>
                <div class="admin-card-grid">
                  <article><span>Role</span><strong>admin</strong><em>可管理用户、角色、芯片和历史</em></article>
                  <article><span>MCP KEY</span><strong>3 active</strong><em>最近生成 2026-05-25</em></article>
                  <article><span>Chip access</span><strong>All</strong><em>继承管理员模板</em></article>
                  <article><span>Audit</span><strong>Ready</strong><em>会话和问题台账可追踪</em></article>
                </div>
                <div class="table-mock">
                  <div><strong>KEY 名称</strong><strong>状态</strong><strong>有效期</strong></div>
                  <div><span>customer-smoke</span><span>active</span><span>2026-06-30</span></div>
                  <div><span>opencode-demo</span><span>active</span><span>never</span></div>
                </div>
              </div>
            </section>
          </div>
        </section>

        <section class="demo-screen" hidden aria-hidden="true" role="tabpanel" aria-labelledby="tab-mcp" data-screen-panel="mcp" aria-label="MCP 接入预览">
          <div class="mcp-preview">
            <div class="mcp-hero">
              <p class="eyebrow">Remote MCP · opencode 优先 · 私有配置</p>
              <h2>客户 MCP 接入</h2>
              <p>服务方发放 MCP URL 和 MCP key，客户通过授权资源 id 作为 chipId 发起 smoke test。</p>
            </div>
            <ol class="step-list">
              <li><strong>准备</strong><span>MCP URL + MCP key</span></li>
              <li><strong>配置</strong><span>生成客户本地私有配置</span></li>
              <li><strong>确认</strong><span>调用 agentx_whoami 查看资源</span></li>
              <li><strong>烟测</strong><span>用 chipId 启动只读会话</span></li>
            </ol>
            <div class="template-grid">
              <article><h3>opencode</h3><pre><code>"type": "remote",
"url": "https://mcp.example.com/mcp",
"headers": { "Authorization": "Bearer ***" }</code></pre></article>
              <article><h3>codex</h3><pre><code>codex mcp add agentx-remote \\
  --url &lt;AGENTX_MCP_URL&gt; \\
  --bearer-token-env-var AGENTX_MCP_KEY</code></pre></article>
              <article><h3>安全边界</h3><p>不要在聊天、截图、日志或共享文档里暴露完整 MCP KEY、JWT、cookie 或私钥。</p></article>
            </div>
          </div>
        </section>
      </main>
    </div>
    <script src="assets/demo-shell.js"></script>
  </body>
</html>
`;
}

function indexPage() {
  const cards = styles.map((style) => `
          <a class="card" href="${style.file}" style="${styleVars(style)}" data-category="${style.category}">
            <div class="card-preview" data-mood="${style.mood}">
              <div class="card-preview-topbar"><span></span><span></span><span></span><em>${escapeHtml(style.slug)}</em></div>
              <div class="card-preview-body">
                <span class="card-kicker">${escapeHtml(style.category)}</span>
                <strong>${escapeHtml(style.name)}</strong>
                <div class="card-mini-grid"><i></i><i></i><i></i><i></i></div>
              </div>
            </div>
            <div class="card-body">
              <div>
                <h3>${style.id} · ${escapeHtml(style.name)}</h3>
                <p>${escapeHtml(style.tagline)}</p>
              </div>
              <span class="card-arrow">进入</span>
            </div>
          </a>`).join('\n');

  const filters = categories.map(([key, label], index) =>
    `<button class="filter-btn${index === 0 ? ' active' : ''}" type="button" data-filter="${key}">${label}</button>`
  ).join('\n          ');

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>AgentX · 55 套 WebUI 风格试衣间</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap">
    <link rel="stylesheet" href="assets/demo-shell.css">
  </head>
  <body class="demo-index">
    <header class="index-topbar">
      <a class="demo-brand" href="../">
        <span class="demo-brand-mark">AX</span>
        <span><strong>AgentX WebUI Demos</strong><small>55 套完整五屏 mock 预览</small></span>
      </a>
      <nav class="index-links" aria-label="Demo categories">
        ${filters}
      </nav>
    </header>
    <main>
      <section class="index-hero">
        <p class="eyebrow">Style fitting room · no real backend calls</p>
        <h1>给 AgentX 试穿 55 套网站风格</h1>
        <p>每套 demo 都包含首页、登录、聊天、Admin 和 MCP 接入五个界面。点击卡片进入后，用顶部 tab 切换不同界面。</p>
        <div class="index-stats"><span><strong>55</strong> styles</span><span><strong>5</strong> screens each</span><span><strong>0</strong> real API calls</span></div>
      </section>
      <section class="card-grid" aria-label="AgentX style demos">
${cards}
      </section>
    </main>
    <footer class="index-footer">
      <span>AgentX · webui-demo branch</span>
      <span>AgentX WebUI skin system demo gallery</span>
    </footer>
    <script>
      const buttons = document.querySelectorAll('.filter-btn');
      const cards = document.querySelectorAll('.card');
      buttons.forEach((button) => {
        button.addEventListener('click', () => {
          const filter = button.dataset.filter;
          buttons.forEach((item) => item.classList.toggle('active', item === button));
          cards.forEach((card) => {
            card.hidden = filter !== 'all' && card.dataset.category !== filter;
          });
        });
      });
    </script>
  </body>
</html>
`;
}

mkdirSync(assetDir, { recursive: true });
for (const style of styles) {
  writeFileSync(path.join(outDir, style.file), `\uFEFF${demoPage(style)}`, 'utf8');
}
writeFileSync(path.join(outDir, 'index.html'), `\uFEFF${indexPage()}`, 'utf8');
writeFileSync(path.join(assetDir, 'demo-data.js'), `window.AgentXDemoStyles = ${JSON.stringify(styles, null, 2)};\n`, 'utf8');

console.log(`Generated ${styles.length} AgentX WebUI demo pages.`);
