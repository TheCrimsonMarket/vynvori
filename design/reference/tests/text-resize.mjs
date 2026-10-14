/** Calibrated text-only simulation: snapshot before ANY mutation, then assign absolute doubled px.
 * New DOM content is remeasured at baseline before applying the same scale; ancestor percentages
 * never multiply child percentages. Images, viewport and spatial padding remain unchanged.
 */
export async function doubleText(page){await page.evaluate(()=>{
 const original=new Map();let scheduled=false,latest=[];
 function apply(){scheduled=false;for(const [el,style] of original){el.style.removeProperty('font-size');if(style.value)el.style.setProperty('font-size',style.value,style.priority);}
 const snapshot=[...document.querySelectorAll('*')].filter(el=>el instanceof HTMLElement&&!['SCRIPT','STYLE','NOSCRIPT'].includes(el.tagName)).map(el=>({el,size:parseFloat(getComputedStyle(el).fontSize)}));
 for(const {el} of snapshot)if(!original.has(el))original.set(el,{value:el.style.getPropertyValue('font-size'),priority:el.style.getPropertyPriority('font-size')});
 for(const {el,size} of snapshot)el.style.setProperty('font-size',`${size*2}px`,'important');
 latest=snapshot.filter(({el})=>[...el.childNodes].some(n=>n.nodeType===Node.TEXT_NODE&&n.textContent.trim())||['INPUT','TEXTAREA','SELECT'].includes(el.tagName)).map(({el,size})=>({tag:el.tagName,id:el.id,classes:el.className,text:el.textContent.trim().slice(0,55),beforePx:size,afterPx:parseFloat(getComputedStyle(el).fontSize),ratio:parseFloat(getComputedStyle(el).fontSize)/size}));return latest;
 }
 new MutationObserver(()=>{if(!scheduled){scheduled=true;requestAnimationFrame(apply);}}).observe(document.body,{childList:true,subtree:true});
 window.__textResize={refresh:apply,report:()=>latest};return apply();
 });await page.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});return page.evaluate(()=>window.__textResize.report());}
