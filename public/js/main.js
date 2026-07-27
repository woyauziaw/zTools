/**
 * Handles Tab navigation on the front end.
 * @param {'yt' | 'file'} tab - Target tab to show.
 */
function switchTab(tab) {
  const isYt = tab === 'yt';
  document.getElementById('tabYt').classList.toggle('hidden', !isYt);
  document.getElementById('tabFile').classList.toggle('hidden', isYt);

  const btnYt = document.getElementById('btnTabYt');
  const btnFile = document.getElementById('btnTabFile');

  btnYt.className = isYt 
    ? 'flex-1 py-2 font-semibold text-indigo-400 border-b-2 border-indigo-500 transition-colors' 
    : 'flex-1 py-2 font-semibold text-slate-400 transition-colors';
    
  btnFile.className = !isYt 
    ? 'flex-1 py-2 font-semibold text-indigo-400 border-b-2 border-indigo-500 transition-colors' 
    : 'flex-1 py-2 font-semibold text-slate-400 transition-colors';
}

/**
 * Handles client-side extraction and upload logic for YouTube URLs sequentially.
 */
async function processYoutube() {
  const text = document.getElementById('ytUrls').value.trim();
  if (!text) return alert('Please enter at least one YouTube URL.');

  const urls = text.split('\n').map((u) => u.trim()).filter((u) => u.length > 0);
  if (urls.length > 10) return alert('Maximum 10 URLs are supported at once.');

  toggleLoading(true, 'Initializing YouTube downloads...');
  const results = [];

  for (let i = 0; i < urls.length; i++) {
    const targetUrl = urls[i];
    try {
      updateStatus(`[${i + 1}/${urls.length}] Scraping and uploading stream to Top4Top...`);
      
      const response = await fetch('/api/ytdl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl })
      });
      
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Server error');

      results.push({ title: data.title, url: data.url });
    } catch (err) {
      results.push({ title: targetUrl, url: 'Failed: ' + err.message });
    }
  }

  toggleLoading(false);
  renderResults(results);
}

/**
 * Handles direct file uploading logic sequentially to prevent server payload overload.
 */
async function processFiles() {
  const input = document.getElementById('fileInput');
  if (!input.files || input.files.length === 0) return alert('Select files first.');
  if (input.files.length > 10) return alert('Maximum 10 files allowed.');

  toggleLoading(true, 'Uploading files...');
  const results = [];

  for (let i = 0; i < input.files.length; i++) {
    const file = input.files[i];
    updateStatus(`[${i + 1}/${input.files.length}] Uploading ${file.name} to Top4Top...`);
    
    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Upload error');

      results.push({ title: data.title, url: data.url });
    } catch (err) {
      results.push({ title: file.name, url: 'Failed: ' + err.message });
    }
  }

  toggleLoading(false);
  renderResults(results);
}

/**
 * Updates result table rendering.
 * @param {Array<{title: string, url: string}>} items - Output items.
 */
function renderResults(items) {
  const tbody = document.getElementById('resultBody');
  tbody.innerHTML = '';

  items.forEach((item) => {
    const valid = item.url.startsWith('http');
    const row = document.createElement('tr');
    
    row.innerHTML = `
      <td class="p-3 truncate max-w-[200px] text-slate-300" title="${item.title}">${item.title}</td>
      <td class="p-3"><code class="text-indigo-400 select-all whitespace-nowrap">${item.url}</code></td>
      <td class="p-3 text-center">
        ${valid 
          ? `<button onclick="navigator.clipboard.writeText('${item.url}')" class="px-3 py-1 text-xs font-semibold bg-slate-700 hover:bg-slate-600 rounded transition-colors">Copy</button>` 
          : '<span class="text-red-400 text-xs">Error</span>'}
      </td>
    `;
    tbody.appendChild(row);
  });

  document.getElementById('resultBox').classList.remove('hidden');
}

/**
 * Toggles loader state and disables buttons.
 * @param {boolean} show - Display flag.
 * @param {string} text - Message context.
 */
function toggleLoading(show, text = '') {
  document.getElementById('loading').classList.toggle('hidden', !show);
  document.getElementById('btnProcessYt').disabled = show;
  document.getElementById('btnProcessFile').disabled = show;
  if (text) updateStatus(text);
}

/**
 * Sets loader status string.
 * @param {string} msg - Message payload.
 */
function updateStatus(msg) {
  document.getElementById('statusText').innerText = msg;
}
