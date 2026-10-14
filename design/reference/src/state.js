/* Release 1.0 local controller; no production contracts or external calls. */
const assets='assets/';
const uploads=[];
const studioFixtures=['arch','chromatic'];
const catalogue=[
 {id:'rupture',name:'Rupture / 01',category:'monochrome',note:'A broken circle. Three open arches.',prompt:'A distressed ivory circle suspended above three open arches. Quiet, architectural, on black.'},
 {id:'arch',name:'Open structure / 02',category:'monochrome',note:'Space, framed in ivory.',file:'arch-study.svg',prompt:'An original architectural study in ivory. Open arches, fine lines and negative space on black.'},
 {id:'chromatic',name:'Chromatic study / 03',category:'color',note:'A prism. A passage. A new perspective.',file:'chromatic-study.svg',prompt:'An original chromatic prism suspended in an elliptical frame. Restrained mineral colors on black.'}
];
const S={product:'rupture',filter:'all',sort:'editorial',size:null,productView:'back',prompt:'',generation:'empty',selected:null,side:'back',panel:'canvas',safe:true,demoOutcome:'success',zoom:1,placements:{front:null,back:{art:'arch',x:50,y:46,scale:26}},bag:[],error:'',generationToken:0};
const main=document.querySelector('#main');
const $=s=>document.querySelector(s);
const escapeHTML=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const item=id=>[...catalogue,...uploads].find(x=>x.id===id)||catalogue[0];
const btn=(text,action,cls='',extra='')=>`<button class="${cls}" data-action="${action}" ${extra}>${text}</button>`;
const route=(text,to,cls='btn',extra='')=>`<a class="${cls}" href="#${to}" ${extra}>${text}<span aria-hidden="true">↗</span></a>`;
