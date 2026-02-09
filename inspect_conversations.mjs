import WebSocket from 'ws';

const WS_URL = 'ws://127.0.0.1:9222/devtools/page/F22BBF7B46CDE00B2F13E435686422E5';
const TARGET_CONTEXT_ID = 12;

async function main() {
  const ws = new WebSocket(WS_URL);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  let idCounter = 1;
  const contexts = [];
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.method === 'Runtime.executionContextCreated') {
        contexts.push(data.params.context);
      }
    } catch {}
  });

  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = idCounter++;
      const timeout = setTimeout(() => reject(new Error(`Timeout: ${method}`)), 10000);
      const handler = (msg) => {
        const data = JSON.parse(msg);
        if (data.id === id) {
          clearTimeout(timeout);
          ws.off('message', handler);
          if (data.error) reject(data.error);
          else resolve(data.result);
        }
      };
      ws.on('message', handler);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evalInContext(expression) {
    const res = await call('Runtime.evaluate', {
      expression,
      contextId: TARGET_CONTEXT_ID,
      returnByValue: true
    });
    return res?.result?.value;
  }

  await call('Runtime.enable', {});
  await new Promise(r => setTimeout(r, 500));

  // Step 1: Click "Past conversations" button
  console.log('=== Step 1: Clicking "Past conversations" button ===');
  const clickRes = await evalInContext(`
    (function() {
      const btn = document.querySelector('button.sessionsButton_aqhumA') 
                || document.querySelector('button[title="Past conversations"]');
      if (btn) { btn.click(); return 'Clicked: class=' + btn.className; }
      return 'NOT FOUND';
    })()
  `);
  console.log(clickRes);

  // Wait for panel animation
  await new Promise(r => setTimeout(r, 1000));

  // Step 2: Dump ALL buttons again (post-click)
  console.log('\n=== Step 2: All buttons after opening panel ===');
  const allBtns = await evalInContext(`
    (function() {
      const allBtns = Array.from(document.querySelectorAll('button'));
      return JSON.stringify(allBtns.map(b => ({
        className: b.className,
        title: b.title || '',
        ariaLabel: b.getAttribute('aria-label') || '',
        text: b.textContent.trim().slice(0, 100),
        dataAttrs: Array.from(b.attributes).filter(a => a.name.startsWith('data-')).map(a => a.name + '=' + a.value).join(', ')
      })), null, 2);
    })()
  `);
  
  try {
    const buttons = JSON.parse(allBtns);
    console.log(`Total buttons: ${buttons.length}\n`);
    
    // Group by className for summary
    const classCounts = {};
    for (const btn of buttons) {
      const key = btn.className || '(empty)';
      if (!classCounts[key]) classCounts[key] = { count: 0, examples: [] };
      classCounts[key].count++;
      if (classCounts[key].examples.length < 2) {
        classCounts[key].examples.push(btn.text.slice(0, 60));
      }
    }
    
    console.log('--- Button classes summary ---');
    for (const [cls, info] of Object.entries(classCounts)) {
      console.log(`  "${cls}" x${info.count} -> examples: ${info.examples.map(e => JSON.stringify(e)).join(', ')}`);
    }
    
    console.log('\n--- All buttons detail ---');
    for (const btn of buttons) {
      console.log(`  class="${btn.className}" text="${btn.text.slice(0, 80)}" title="${btn.title}" aria="${btn.ariaLabel}" data=[${btn.dataAttrs}]`);
    }
  } catch (e) {
    console.log('Raw:', allBtns);
  }

  // Step 3: Look for conversation list structure specifically
  console.log('\n=== Step 3: Conversation list DOM structure ===');
  const domStructure = await evalInContext(`
    (function() {
      // Look for the sessions/conversations panel
      // The "Past conversations" button was clicked, so there should be a panel
      // Let's check for any new containers that appeared
      
      // Find all elements with class containing 'session' or 'conversation' or 'history'
      const allEls = document.querySelectorAll('*');
      const interesting = [];
      for (const el of allEls) {
        const cls = el.className;
        if (typeof cls === 'string' && (
          cls.includes('session') || cls.includes('Session') ||
          cls.includes('conversation') || cls.includes('Conversation') ||
          cls.includes('history') || cls.includes('History') ||
          cls.includes('list') || cls.includes('List') ||
          cls.includes('panel') || cls.includes('Panel')
        )) {
          const childBtns = el.querySelectorAll('button');
          interesting.push({
            tag: el.tagName,
            className: cls,
            role: el.getAttribute('role') || '',
            childButtonCount: childBtns.length,
            firstChildBtnClass: childBtns[0]?.className || '',
            firstChildBtnText: childBtns[0]?.textContent?.trim().slice(0, 60) || '',
          });
        }
      }
      return JSON.stringify(interesting, null, 2);
    })()
  `);
  
  try {
    const items = JSON.parse(domStructure);
    console.log(`Found ${items.length} elements with session/conversation/history/list/panel in class:\n`);
    for (const item of items) {
      console.log(`  <${item.tag} class="${item.className}" role="${item.role}">`);
      console.log(`    childButtons: ${item.childButtonCount}, firstBtn class="${item.firstChildBtnClass}" text="${item.firstChildBtnText}"`);
    }
  } catch (e) {
    console.log('Raw:', domStructure);
  }

  // Step 4: Get the full parent chain for any conversation-like buttons
  console.log('\n=== Step 4: Conversation item buttons detail ===');
  const convDetail = await evalInContext(`
    (function() {
      // Find buttons that look like conversation list items
      // They should have appeared after clicking Past conversations
      // Exclude known non-conversation buttons
      const knownNonConv = ['copyButton', 'actionButton', 'iconButton', 'sessionsButton'];
      const allBtns = Array.from(document.querySelectorAll('button'));
      const convBtns = allBtns.filter(b => {
        const cls = b.className;
        return !knownNonConv.some(k => cls.includes(k)) && b.textContent.trim().length > 5;
      });
      
      return JSON.stringify(convBtns.map(b => {
        // Full parent chain
        let parents = [];
        let el = b.parentElement;
        for (let i = 0; i < 5 && el; i++) {
          parents.push({
            tag: el.tagName,
            className: (typeof el.className === 'string' ? el.className : '').slice(0, 120),
            role: el.getAttribute('role') || ''
          });
          el = el.parentElement;
        }
        
        // Child structure
        const children = Array.from(b.children).map(c => ({
          tag: c.tagName,
          className: c.className,
          text: c.textContent.trim().slice(0, 50)
        }));
        
        return {
          className: b.className,
          text: b.textContent.trim().slice(0, 120),
          title: b.title,
          ariaLabel: b.getAttribute('aria-label') || '',
          parents,
          children,
          innerHTML: b.innerHTML.slice(0, 300)
        };
      }), null, 2);
    })()
  `);
  
  try {
    const convBtns = JSON.parse(convDetail);
    console.log(`Found ${convBtns.length} potential conversation buttons:\n`);
    for (let i = 0; i < Math.min(convBtns.length, 10); i++) {
      const btn = convBtns[i];
      console.log(`  [${i}] class="${btn.className}"`);
      console.log(`      text="${btn.text}"`);
      console.log(`      title="${btn.title}" aria="${btn.ariaLabel}"`);
      console.log(`      children: ${btn.children.map(c => `<${c.tag} class="${c.className}">${c.text.slice(0, 30)}`).join(', ')}`);
      console.log(`      parent chain: ${btn.parents.map(p => `<${p.tag} class="${p.className.slice(0, 60)}">`).join(' -> ')}`);
      console.log(`      innerHTML: ${btn.innerHTML.slice(0, 200)}`);
      console.log('');
    }
  } catch (e) {
    console.log('Raw:', convDetail);
  }

  // Step 5: Close the panel
  console.log('\n=== Step 5: Closing panel ===');
  const closeRes = await evalInContext(`
    (function() {
      const btn = document.querySelector('button.sessionsButton_aqhumA') 
                || document.querySelector('button[title="Past conversations"]');
      if (btn) { btn.click(); return 'Closed'; }
      return 'Not found';
    })()
  `);
  console.log(closeRes);

  ws.close();
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
