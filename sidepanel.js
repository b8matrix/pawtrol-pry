function Y(e,s,t){let n=Math.max(0,e),r=Math.max(0,s),i=Math.max(0,t);return{precision:n+r>0?n/(n+r):null,recall:n+i>0?n/(n+i):null}}var a=e=>document.getElementById(e),u=a("transcript"),J=a("empty"),h=a("task-input"),Q=a("run-btn"),X=a("stop-btn"),oe=a("status-dot"),G=a("status-text"),ee=a("confirm"),z=a("confirm-text"),S=a("privacy-audit"),M=a("history-panel"),R=a("learning-dashboard"),I=a("tripwire-panel"),N=a("egress-badge"),H=a("perception-counter"),A=new Map,T=new Map,w=null,B=0;function f(e){return chrome.runtime.sendMessage(e).catch(()=>{})}function C(e){return e.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}function te(e){return e.replace(/"/g,"&quot;").replace(/'/g,"&#39;")}function se(e){if(!e)return"";let s=[],t=e.replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g,(r,i,d)=>{let l=`@@CODE_BLOCK_${s.length}@@`,c=C(d.trim()),E=i?`<div class="code-header"><span class="code-lang">${C(i.toUpperCase())}</span></div>`:"";return s.push(`
      <div class="chat-code-block">
        ${E}
        <pre><code>${c}</code></pre>
      </div>
    `),l});t=C(t),t=t.replace(/&lt;([A-Z]+_\d+)&gt;/g,'<span class="vault-token-badge">&lt;$1&gt;</span>'),t=t.replace(/`([^`\n]+)`/g,'<code class="chat-inline-code">$1</code>'),t=t.replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>"),t=t.replace(/__([^_]+)__/g,"<strong>$1</strong>"),t=t.replace(/(^|[^*])\*([^*]+)\*(?=[^*]|$)/g,"$1<em>$2</em>"),t=t.replace(/^### (.*$)/gim,'<h5 class="chat-h3">$1</h5>'),t=t.replace(/^## (.*$)/gim,'<h4 class="chat-h2">$1</h4>'),t=t.replace(/^# (.*$)/gim,'<h3 class="chat-h1">$1</h3>'),t=t.replace(/^[*-]\s+(.*$)/gim,'<li class="chat-li">$1</li>'),t=t.replace(/^\d+\.\s+(.*$)/gim,'<li class="chat-oli">$1</li>'),t=t.replace(/((?:<li class="chat-li">.*?<\/li>\s*)+)/g,'<ul class="chat-ul">$1</ul>'),t=t.replace(/((?:<li class="chat-oli">.*?<\/li>\s*)+)/g,'<ol class="chat-ol">$1</ol>'),t=t.split(/\n{2,}/).map(r=>{let i=r.trim();return i?i.startsWith("<div")||i.startsWith("<ul")||i.startsWith("<ol")||i.startsWith("<h3")||i.startsWith("<h4")||i.startsWith("<h5")||i.startsWith("@@CODE_BLOCK_")?i:`<p class="chat-p">${i.replace(/\n/g,"<br/>")}</p>`:""}).filter(Boolean).join(`
`);for(let r=0;r<s.length;r++)t=t.replace(`@@CODE_BLOCK_${r}@@`,s[r]);return t}function b(e){let t=e&&(n=>{switch(n){case"privacy-audit":return!S.classList.contains("hidden");case"learning-dashboard":return!R.classList.contains("hidden");case"tripwire-panel":return!I?.classList.contains("hidden");case"history-panel":return!M.classList.contains("hidden")}})(e)?null:e;if(S.classList.add("hidden"),R.classList.add("hidden"),I?.classList.add("hidden"),M.classList.add("hidden"),a("btn-perception")?.classList.toggle("active",t==="privacy-audit"),a("btn-learning")?.classList.toggle("active",t==="learning-dashboard"),a("btn-radar")?.classList.toggle("active",t==="tripwire-panel"),a("btn-history")?.classList.toggle("active",t==="history-panel"),!!t)switch(t){case"privacy-audit":S.classList.remove("hidden");break;case"learning-dashboard":R.classList.remove("hidden"),F();break;case"tripwire-panel":I?.classList.remove("hidden"),re();break;case"history-panel":M.classList.remove("hidden"),fe();break}}function le(e){if(e<=0)return"0 KB";if(e<1024)return`${e} B`;let s=e/1024;return s<10?`${s.toFixed(1)} KB`:`${Math.round(s)} KB`}function D(){return u.scrollHeight-u.scrollTop-u.clientHeight<60}function ce(){B++,H&&(H.textContent=`PERCEPTION N\xB0 ${String(B).padStart(2,"0")}`)}var de={click:"\u2192",type:"\u2328",select:"\u25BE",scroll:"\u2195",key:"\u23CE",find_text:"\u2315",wait:"\u25F7",read_page:"\u25C9",navigate:"\u21E2",go_back:"\u21E0",open_tab:"\uFF0B",switch_tab:"\u21C4",close_tab:"\xD7",list_tabs:"\u2630"};function ne(e){J.classList.add("hidden");let s=D(),t=A.get(e.id);if(!t){if(t=document.createElement("div"),t.className=`entry ${e.role}`,e.role==="step")t.innerHTML='<span class="glyph"></span><span class="detail"></span>';else if(e.role==="assistant"){t.innerHTML=`
        <div class="assistant-header">
          <div class="assistant-tag">
            <span class="assistant-dot"></span>
            <span class="assistant-name">PAWTROL</span>
          </div>
          <button class="btn-copy-chat" type="button" title="Copy response">
            <span class="copy-icon">\u{1F4CB}</span>
            <span class="copy-label">Copy</span>
          </button>
        </div>
        <div class="assistant-body"></div>
      `;let n=t.querySelector(".btn-copy-chat");n?.addEventListener("click",()=>{let r=T.get(e.id)??"";if(navigator.clipboard){navigator.clipboard.writeText(r);let i=n.querySelector(".copy-label");i&&(i.textContent="\u2713 Copied",setTimeout(()=>{i.textContent="Copy"},1600))}})}else e.role==="user"?t.innerHTML=`
        <div class="user-bubble">
          <div class="user-tag">YOU</div>
          <div class="user-text"></div>
        </div>
      `:e.role==="egress"&&(t.innerHTML=`
        <div class="egress-row">
          <span class="egress-glyph">\u{1F6E1}\uFE0F</span>
          <div class="egress-body"></div>
          <button class="egress-inspect" type="button" title="Open the live egress radar">RADAR \u2192</button>
        </div>
      `,t.querySelector(".egress-inspect")?.addEventListener("click",()=>{b("tripwire-panel")}));A.set(e.id,t),u.appendChild(t)}if(T.set(e.id,e.text),e.role==="step"){let n=t.querySelector(".glyph");n&&(n.textContent=de[e.action??""]??"\u2022");let r=t.querySelector(".detail");r&&(r.textContent=e.text),t.classList.toggle("pending",e.pending===!0)}else if(e.role==="assistant"){let n=t.querySelector(".assistant-body");n&&(n.innerHTML=se(e.text))}else if(e.role==="user"){let n=t.querySelector(".user-text");n&&(n.textContent=e.text)}else if(e.role==="egress"){let n=t.querySelector(".egress-body");n&&(n.textContent=e.text)}else t.textContent=e.text;s&&(u.scrollTop=u.scrollHeight)}function V(e){oe?.classList.toggle("running",e),G&&(G.textContent=e?"RUNNING":"IDLE"),Q?.classList.toggle("hidden",e),X?.classList.toggle("hidden",!e),h&&(h.disabled=e)}var pe={face:"\u{1F464}",credential:"\u{1F511}",id_number:"\u{1FAAA}",api_key:"\u{1F5DD}\uFE0F",pii_text:"\u{1F4DD}",input_field:"\u2328"};function ue(e){let s=a("audit-summary"),t=new Set(e.allTokens.map(d=>d.token)).size;s.innerHTML=`
    <div class="audit-stat">
      <span class="number">${e.totalPIIDetections}</span>
      <span class="label">PII Detected</span>
    </div>
    <div class="audit-stat">
      <span class="number">${e.totalRedacted}</span>
      <span class="label">Items Redacted</span>
    </div>
    <div class="audit-stat">
      <span class="number">${t}</span>
      <span class="label">Tokens Created</span>
    </div>
  `;let n=a("audit-screenshots");if(e.screenshots.length>0){n.innerHTML="<h4>Before / After Redaction</h4>";for(let d of e.screenshots){let l=document.createElement("div");l.className="screenshot-pair",d.original&&(l.innerHTML+=`
          <div class="shot">
            <img src="${d.original}" alt="Original" />
            <div class="shot-label">Original</div>
          </div>`),d.redacted&&(l.innerHTML+=`
          <div class="shot">
            <img src="${d.redacted}" alt="Redacted (Shipped to Model)" />
            <div class="shot-label">Redacted</div>
          </div>`),n.appendChild(l)}}else n.innerHTML='<h4>Screenshots</h4><p class="empty-sub">No screenshots were sent during this task.</p>';let r=a("audit-detections");if(e.allDetections.length>0){r.innerHTML='<h4>Detected Regions</h4><div class="detection-list"></div>';let d=r.querySelector(".detection-list");for(let l of e.allDetections){let c=document.createElement("div");c.className="detection-chip";let E=pe[l.kind]??"\u{1F4CC}",$=l.label||l.kind;c.innerHTML=`
        <span class="kind">${E} ${$}</span>
        <span class="conf">${Math.round(l.confidence*100)}%</span>
      `;let v=document.createElement("button");v.type="button",v.className="fp-btn",v.textContent="\u2715 not PII",v.dataset.kind=l.kind,v.dataset.label=$,v.addEventListener("click",()=>void he(v)),c.appendChild(v),d.appendChild(c)}}else r.innerHTML='<h4>Detected Regions</h4><p class="empty-sub">No sensitive regions detected.</p>';let i=a("audit-tokens");if(e.allTokens.length>0){i.innerHTML='<h4>Token Vault</h4><div class="token-list"></div>';let d=i.querySelector(".token-list");for(let l of e.allTokens){let c=document.createElement("div");c.className="token-chip";let E=l.kind==="pii_text"?"PII text":l.kind==="id_number"?"ID number":l.kind==="api_key"?"API key":l.kind;c.textContent=l.sample?`${l.token} \u2192 ${l.sample} (${E})`:`${l.token} (${E})`,c.title="Raw value replaced by this token \u2014 never stored or sent",d.appendChild(c)}}else i.innerHTML='<h4>Token Vault</h4><p class="empty-sub">No values needed tokenizing on this page.</p>';me(e)}function me(e){let s=document.createElement("div");s.className="entry audit-chip";let t=e.verification?.verified?'<span class="chip-status ok">\u2713 ZERO-LEAK VERIFIED</span>':'<span class="chip-status warn">\u{1F512} PRIVACY AUDIT</span>',n=new Set(e.allTokens.map(r=>r.token)).size;s.innerHTML=`
    <div class="audit-chip-left">
      <div class="audit-chip-badge">${t}</div>
      <div class="audit-chip-stats">
        <span>\u{1F6E1}\uFE0F <strong>${e.totalRedacted}</strong> Redacted</span>
        <span>\u{1F511} <strong>${n}</strong> Vault Tokens</span>
        <span>\u{1F4F8} <strong>${e.totalScreenshots}</strong> Frames</span>
      </div>
    </div>
    <button class="audit-chip-inspect-btn" type="button">INSPECT PROOF \u2192</button>
  `,s.querySelector(".audit-chip-inspect-btn")?.addEventListener("click",()=>{b("privacy-audit")}),u.appendChild(s),D()&&(u.scrollTop=u.scrollHeight)}chrome.runtime.onMessage.addListener(e=>{switch(e.kind){case"entry":ne(e.entry);break;case"patch":{let s=A.get(e.id);if(!s)break;if(e.text!==void 0)if(s.classList.contains("assistant")){let t=(T.get(e.id)??"")+e.text;T.set(e.id,t);let n=s.querySelector(".assistant-body");n&&(n.innerHTML=se(t))}else if(s.classList.contains("step")){let t=(T.get(e.id)??"")+e.text;T.set(e.id,t);let n=s.querySelector(".detail");n&&(n.textContent=t)}else if(s.classList.contains("egress")){T.set(e.id,e.text??"");let t=s.querySelector(".egress-body");t&&(t.textContent=e.text??"")}else s.textContent=e.text;e.pending!==void 0&&s.classList.toggle("pending",e.pending),D()&&(u.scrollTop=u.scrollHeight);break}case"status":V(e.running);break;case"egress":N&&(N.textContent=`${le(e.bytes)} EGRESS`);break;case"confirm":w=e.id,z&&(z.textContent=e.summary),ee.classList.remove("hidden");break;case"privacy-audit":ue(e.audit);break;case"learning-update":j(e.stats);break;case"tripwire-update":I?.classList.contains("hidden")||re();break;case"experience":ge(e.experience);break}});function ge(e){if(!e?.id)return;document.getElementById("outcome-feedback")?.remove();let s=document.createElement("div");s.id="outcome-feedback",s.className="outcome-feedback",s.innerHTML=`
    <span class="outcome-label">Was this helpful?</span>
    <button type="button" class="outcome-btn" data-helpful="true">\u{1F44D} Yes</button>
    <button type="button" class="outcome-btn" data-helpful="false">\u{1F44E} No</button>
  `;let t=n=>{f({kind:"record-outcome",experienceId:e.id,helpful:n}),s.classList.add("done");let r=s.querySelector(".outcome-label");r&&(r.textContent=n?"\u{1F44D} Noted \u2014 thanks!":"\u{1F44E} Noted \u2014 recorded as a failure."),s.querySelectorAll(".outcome-btn").forEach(i=>i.remove())};s.querySelector(".outcome-btn[data-helpful='true']")?.addEventListener("click",()=>t(!0)),s.querySelector(".outcome-btn[data-helpful='false']")?.addEventListener("click",()=>t(!1)),u.appendChild(s),D()&&(u.scrollTop=u.scrollHeight)}function j(e){let s=a("learning-stats"),t=e.improvementDelta>0?"positive":e.improvementDelta<0?"negative":"",n=e.improvementDelta>0?"+":"",{precision:r,recall:i}=Y(e.piiRedacted,e.falsePositives,e.missedPII),d=p=>p===null?"":p>=.85?"positive":p<.6?"negative":"",l=p=>p===null?"\u2014":`${Math.round(p*100)}%`;s.innerHTML=`
    <div class="learning-stat">
      <span class="number">${e.totalRuns}</span>
      <span class="label">TOTAL RUNS</span>
    </div>
    <div class="learning-stat">
      <span class="number ${e.successRate>=80?"positive":"negative"}">${e.successRate}%</span>
      <span class="label">SUCCESS RATE</span>
    </div>
    <div class="learning-stat">
      <span class="number ${t}">${n}${Math.round(e.improvementDelta*100)}%</span>
      <span class="label">IMPROVEMENT</span>
    </div>
    <div class="learning-stat">
      <span class="number ${d(r)}">${l(r)}</span>
      <span class="label">PRECISION</span>
    </div>
    <div class="learning-stat">
      <span class="number ${d(i)}">${l(i)}</span>
      <span class="label">RECALL</span>
    </div>
    <div class="learning-stat">
      <span class="number">${e.piiDetected}</span>
      <span class="label">PII DETECTED</span>
    </div>
    <div class="learning-stat">
      <span class="number positive">${e.piiRedacted}</span>
      <span class="label">PII REDACTED</span>
    </div>
    <div class="learning-stat">
      <span class="number">${e.rulesSummary.total}</span>
      <span class="label">RULES LEARNED</span>
    </div>
  `;let c=a("learning-rules"),E={pii_detection:"PII Detection",strategy:"Strategy",site_pattern:"Site Pattern",redaction:"Redaction",safety:"Safety"};if(e.rulesSummary.total>0){c.innerHTML=`<h4>Learned Rules (${e.rulesSummary.total})</h4><div class="rule-list"></div>`;let p=c.querySelector(".rule-list"),L=e.rulesSummary.recent??[];if(L.length>0)for(let o of L){let g=document.createElement("div");g.className="rule-item";let m=document.createElement("div");m.className="rule-top";let y=document.createElement("span");y.className=`rule-tag ${o.category}`,y.textContent=E[o.category]??o.category;let k=document.createElement("span");k.className="rule-conf",k.textContent=`conf ${Math.round(o.confidence*100)}%${o.confirmedCount>0?` \xB7 confirmed \xD7${o.confirmedCount}`:""}`,m.appendChild(y),m.appendChild(k);let q=document.createElement("span");q.className="rule-desc",q.textContent=o.description,g.appendChild(m),g.appendChild(q),p.appendChild(g)}else for(let[o,g]of Object.entries(e.rulesSummary.byCategory)){let m=document.createElement("span");m.className=`rule-chip ${o}`,m.textContent=`${E[o]??o}: ${g}`,p.appendChild(m)}if(e.rulesSummary.highConfidence>0){let o=document.createElement("span");o.className="rule-chip",o.style.cssText="border-color: var(--color-teal); color: var(--color-teal);",o.textContent=`${e.rulesSummary.highConfidence} high-confidence`,p.appendChild(o)}}else c.innerHTML='<h4>Learned Rules</h4><p class="empty-sub">No rules learned yet. Complete tasks to start improving.</p>';let $=document.createElement("p");if($.className="empty-sub",$.style.cssText="margin:6px 0 0;",(e.corrections??0)>0&&($.textContent=`${e.corrections} user-flagged false positive(s) corrected across runs \u2014 each one taught a rule.`,c.appendChild($)),e.falsePositives>0&&e.rulesSummary.total>0){let p=document.createElement("p");p.className="empty-sub",p.style.cssText="margin:6px 0 0;",p.textContent=`False-positive filters avoided ${e.falsePositives} lookalike(s) across runs (Verhoeff/Luhn checksums + learned rules).`,c.appendChild(p)}let v=a("learning-lessons"),K=e.lessons?.total??0;if(K>0){v.innerHTML=`<h4>Lessons Learned (${K})</h4><div class="lesson-list"></div>`;let p=v.querySelector(".lesson-list");for(let L of e.lessons?.recent??[]){let o=document.createElement("div");o.className="lesson-item";let g=document.createElement("div");g.className="rule-top";let m=document.createElement("span");m.className="rule-tag strategy",m.textContent=L.domain;let y=document.createElement("span");y.className="lesson-page",y.textContent=L.pageType||"any page",g.appendChild(m),g.appendChild(y);let k=document.createElement("span");k.className="lesson-text",k.textContent=L.text,o.appendChild(g),o.appendChild(k),p.appendChild(o)}}else v.innerHTML='<h4>Lessons Learned</h4><p class="empty-sub">Failed runs teach lessons here \u2014 so far, none.</p>';let _=a("learning-trajectories"),U=e.trajectories?.total??0;if(U>0){_.innerHTML=`<h4>Replay Library (${U})</h4><div class="traj-list"></div>`;let p=_.querySelector(".traj-list");for(let L of e.trajectories?.recent??[]){let o=document.createElement("div");o.className="lesson-item";let g=document.createElement("div");g.className="rule-top";let m=document.createElement("span");m.className="rule-tag pii_detection",m.textContent=L.domain,g.appendChild(m);let y=document.createElement("span");y.className="traj-task",y.textContent=L.task;let k=document.createElement("span");k.className="traj-steps",k.textContent=L.steps,o.appendChild(g),o.appendChild(y),o.appendChild(k),p.appendChild(o)}}else _.innerHTML='<h4>Replay Library</h4><p class="empty-sub">Successful runs deposit reusable action sequences here.</p>';let W=a("learning-reflection");e.lastReflection?W.innerHTML=`
      <h4>Last Reflection</h4>
      <div class="reflection-text">${C(e.lastReflection)}</div>
    `:W.innerHTML="",ae()}async function ae(){let e=a("ledger-section"),s=await f({kind:"get-ledger"});if(!s?.ledgerSummary){e.innerHTML="";return}let t=s.ledgerSummary,n=t.chainValid?"verified":"tampered",r=t.chainValid?"INTACT":"TAMPERED";e.innerHTML=`
    <h4>Privacy Ledger</h4>
    <div class="ledger-summary">
      <div class="ledger-stat">
        <span class="number">${t.totalEntries}</span>
        <span class="label">ENTRIES</span>
      </div>
      <div class="ledger-stat">
        <span class="number">${t.totalDetections}</span>
        <span class="label">DETECTIONS</span>
      </div>
      <div class="ledger-stat">
        <span class="number">${t.totalRedactions}</span>
        <span class="label">REDACTIONS</span>
      </div>
      <div class="ledger-stat">
        <span class="number">${t.totalSnapshots}</span>
        <span class="label">SNAPSHOTS</span>
      </div>
      <div class="ledger-stat">
        <span class="number">${t.totalActions}</span>
        <span class="label">ACTIONS</span>
      </div>
      <div class="ledger-stat">
        <span class="number ${n}">${r}</span>
        <span class="label">CHAIN</span>
      </div>
    </div>
  `}function ie(e){w&&(f({kind:"confirm-reply",id:w,approved:e}),w=null,ee.classList.add("hidden"))}a("confirm-yes").addEventListener("click",()=>ie(!0));a("confirm-no").addEventListener("click",()=>ie(!1));a("audit-close").addEventListener("click",()=>{S.classList.add("hidden")});async function F(){let e=await f({kind:"get-learning-stats"});if(e&&e.stats){let s=e.stats;j({totalRuns:s.totalRuns??0,successRate:Math.round((s.averageSuccessRate??0)*100),piiDetected:s.totalPIIDetected??0,piiRedacted:s.totalPIIRedacted??0,falsePositives:s.totalFalsePositives??0,missedPII:s.totalMissedPII??0,sitesVisited:s.sitesVisited??0,rulesLearned:s.rulesLearned??0,improvementDelta:s.improvementDelta??0,corrections:s.totalUserCorrections??0,rulesSummary:e.rulesSummary??{total:0,byCategory:{},highConfidence:0,recentlyCreated:0},lessons:e.lessons??{total:0,recent:[]},trajectories:e.trajectories??{total:0,recent:[]},lastReflection:e.lastReflection??""})}else j({totalRuns:0,successRate:0,piiDetected:0,piiRedacted:0,falsePositives:0,missedPII:0,sitesVisited:0,rulesLearned:0,improvementDelta:0,corrections:0,rulesSummary:{total:0,byCategory:{},highConfidence:0,recentlyCreated:0},lessons:{total:0,recent:[]},trajectories:{total:0,recent:[]},lastReflection:""})}async function he(e){e.disabled=!0,e.textContent="\u2026",(await f({kind:"record-correction",piiKind:e.dataset.kind??"",label:e.dataset.label??"",correction:"false_positive"}))?.ok?e.textContent="\u2713 counted":(e.textContent="\u2715 not PII",e.disabled=!1),R.classList.contains("hidden")||await F()}a("btn-learning")?.addEventListener("click",()=>b("learning-dashboard"));a("learning-close")?.addEventListener("click",()=>b(null));a("learning-reset").addEventListener("click",async()=>{await f({kind:"clear-learning"}),await f({kind:"reset"}),await F(),ae()});async function x(e){let s=e??h.value.trim();if(!s)return;let[t]=await chrome.tabs.query({active:!0,currentWindow:!0});t?.id&&(h.value="",h.style.height="auto",b(null),ce(),await f({kind:"run",task:s,tabId:t.id}))}Q.addEventListener("click",()=>void x());h.addEventListener("keydown",e=>{e.key==="Enter"&&!e.shiftKey&&(e.preventDefault(),x())});h.addEventListener("input",()=>{h.style.height="auto",h.style.height=`${Math.min(h.scrollHeight,120)}px`});X.addEventListener("click",()=>{f({kind:"stop"})});a("new-task-btn").addEventListener("click",()=>{f({kind:"reset"}),A.clear(),T.clear(),u.querySelectorAll(".entry").forEach(e=>e.remove()),J.classList.remove("hidden"),b(null),V(!1),B=0,N&&(N.textContent="EGRESS \u2014"),H&&(H.textContent="PERCEPTION N\xB0 01")});a("btn-settings").addEventListener("click",()=>chrome.runtime.openOptionsPage());var P=a("history-list");async function fe(){let s=(await f({kind:"get-history"}))?.sessions??[];if(s.length===0){P.innerHTML='<div class="empty-state" style="padding: 20px;"><p class="empty-sub">No sessions yet. Complete a task to see history here.</p></div>';return}P.innerHTML="";for(let t of s){let n=document.createElement("div");n.className="history-item";let r=new Date(t.completedAt),i=r.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}),d=r.toLocaleDateString([],{month:"short",day:"numeric"}),l=t.durationMs>6e4?`${Math.round(t.durationMs/6e4)}m`:`${Math.round(t.durationMs/1e3)}s`;n.innerHTML=`
      <div class="history-item-task">${C(t.task)}</div>
      <div class="history-item-meta">
        <span class="history-status ${t.status}">${t.status}</span>
        <span>${i} \xB7 ${d}</span>
        <span>${l}</span>
        ${t.piiRedacted>0?`<span>\u{1F512} ${t.piiRedacted}</span>`:""}
      </div>
      <div class="history-item-actions">
        <button class="history-action-btn" data-replay="${te(t.task)}">REPLAY</button>
        <button class="history-action-btn" data-delete="${t.id}">DELETE</button>
      </div>
    `,n.querySelector("[data-replay]")?.addEventListener("click",c=>{c.stopPropagation(),M.classList.add("hidden"),x(t.task)}),n.querySelector("[data-delete]")?.addEventListener("click",c=>{c.stopPropagation(),f({kind:"delete-history",sessionId:t.id}),n.remove()}),P.appendChild(n)}}a("btn-history")?.addEventListener("click",()=>b("history-panel"));a("history-close")?.addEventListener("click",()=>b(null));a("history-clear")?.addEventListener("click",()=>{f({kind:"delete-history",clearAll:!0}),P.innerHTML='<div class="empty-state" style="padding: 20px;"><p class="empty-sub">No sessions yet. Complete a task to see history here.</p></div>'});a("btn-perception")?.addEventListener("click",()=>b("privacy-audit"));a("audit-close")?.addEventListener("click",()=>b(null));var O=a("tripwire-log"),Z=a("tripwire-summary");function be(e,s){if(Z&&(Z.textContent=s),e.length===0){O.innerHTML=`
      <div class="empty-state" style="padding: 14px;">
        <p class="empty-sub">No third-party exfiltration detected. Outbound wire clean.</p>
      </div>
    `;return}O.innerHTML="";for(let t of e){let n=document.createElement("div");n.className="tripwire-log-entry";let r=C((t.piiType||"PII").toUpperCase()),i="";try{i=new URL(t.url).hostname.replace(/^www\./,"")}catch{i=t.url.slice(0,40)}let d=new Date(t.timestamp).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"});n.innerHTML=`
      <span class="tl-kind">${r}</span>
      <span class="tl-method">${C(t.method)}</span>
      <span class="tl-host" title="${te(t.url)}">${C(i)}</span>
      <span class="tl-sample">${C(t.sample)}</span>
      <span class="tl-time">${d}</span>
    `,O.appendChild(n)}}async function re(){let e=await f({kind:"get-tripwire-log"});e&&be(e.alerts??[],e.summary??"")}a("btn-radar")?.addEventListener("click",()=>b("tripwire-panel"));a("tripwire-close")?.addEventListener("click",()=>b(null));window.addEventListener("keydown",e=>{e.key==="Escape"&&b(null)});document.querySelectorAll("[data-action]").forEach(e=>{e.addEventListener("click",()=>{let s=e.dataset.action;x({"fill-form":"Fill all visible form fields on this page with appropriate data","extract-data":"Extract all visible data from this page and list it","scan-pii":"Scan this page for any PII (passwords, IDs, emails, phone numbers) and report what you find","click-target":"Identify and click the primary action button on this page"}[s??""]??"Do something on this page")})});document.querySelectorAll("[data-preset]").forEach(e=>{e.addEventListener("click",()=>{let s=e.dataset.preset;x({aadhaar:"Scan this page for Aadhaar numbers (12-digit) and redact them",pan:"Scan this page for PAN card numbers (5 letters + 4 digits + 1 letter) and redact them",contact:"Scan this page for contact information (emails, phone numbers, addresses) and list them"}[s??""]??"Scan for PII")})});h.addEventListener("input",()=>{h.style.height="auto",h.style.height=`${Math.min(h.scrollHeight,120)}px`});(async()=>{let e=await chrome.runtime.sendMessage({kind:"get-state"});e&&(e.transcript.forEach(ne),V(e.running),u.scrollTop=u.scrollHeight)})();
