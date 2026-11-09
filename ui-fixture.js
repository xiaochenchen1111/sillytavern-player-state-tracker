// Minimal DOM output fixture. It validates mount destination and click wiring,
// and deliberately does not claim to render or validate visual browser layout.
export function makeUiDocument() {
  const nodes=new Map();
  const createNode=id=>{
    const classes=new Set();
    return {id,style:{},dataset:{},hidden:true,scrollTop:0,innerHTML:'',textContent:'',
      classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x),toggle(x,on){if(on)classes.add(x);else classes.delete(x);}},
      focus(){},remove(){nodes.delete(this.id);},querySelector(){return null;}};
  };
  const doc={defaultView:null,getElementById:id=>nodes.get(id)||null,querySelectorAll:()=>[],createElement:()=>createNode(''),
    head:{appendChild(x){nodes.set(x.id,x);}},body:{insertAdjacentHTML(_pos,html){for(const m of html.matchAll(/id="([^"]+)"/g))nodes.set(m[1],createNode(m[1]));},appendChild(){}}};
  doc.defaultView={document:doc,innerHeight:844,addEventListener(){},removeEventListener(){},confirm:()=>true};
  return doc;
}
