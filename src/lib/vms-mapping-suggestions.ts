export type VmsSuggestionProduct={id:string;name:string|null;sku?:string|null;barcode?:string|null};
export type VmsSuggestionInput={vmsProductId?:string|null;vmsProductName?:string|null;thirdPartyProductId?:string|null;barcode?:string|null};

function normalize(value:unknown){
 return String(value??"").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g," ").trim().replace(/\s+/g," ");
}
function compact(value:unknown){return normalize(value).replace(/\s+/g,"");}
function tokens(value:unknown){return new Set(normalize(value).split(" ").filter(Boolean));}
function levenshtein(a:string,b:string){
 if(a===b)return 0;if(!a.length)return b.length;if(!b.length)return a.length;
 const prev=Array.from({length:b.length+1},(_,i)=>i),curr=new Array<number>(b.length+1);
 for(let i=1;i<=a.length;i++){curr[0]=i;for(let j=1;j<=b.length;j++)curr[j]=Math.min(curr[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));for(let j=0;j<=b.length;j++)prev[j]=curr[j];}
 return prev[b.length];
}
function similarity(a:string,b:string){
 if(!a||!b)return 0;
 const distance=levenshtein(a,b);
 return Math.max(0,1-distance/Math.max(a.length,b.length));
}
function tokenOverlap(a:Set<string>,b:Set<string>){
 if(!a.size||!b.size)return 0;
 let intersection=0;for(const token of a)if(b.has(token))intersection++;
 return intersection/Math.max(a.size,b.size);
}

export function suggestVmsProduct(input:VmsSuggestionInput,products:VmsSuggestionProduct[]){
 const vmsName=normalize(input.vmsProductName),vmsCompact=compact(input.vmsProductName),vmsTokens=tokens(input.vmsProductName);
 const ids=[normalize(input.vmsProductId),normalize(input.thirdPartyProductId)].filter(Boolean);
 const barcode=normalize(input.barcode);
 let best:{product:VmsSuggestionProduct;score:number;reason:string}|null=null;
 for(const product of products){
  const productName=normalize(product.name),productCompact=compact(product.name),productTokens=tokens(product.name);
  let score=0,reason="";
  if(barcode&&normalize(product.barcode)===barcode){score=1;reason="Exact barcode";}
  else if(ids.some(id=>id&&normalize(product.sku)===id)){score=.99;reason="Exact XY ID / Snacky SKU";}
  else if(vmsName&&productName===vmsName){score=.98;reason="Exact product name";}
  else{
   const tokenScore=tokenOverlap(vmsTokens,productTokens);
   const editScore=similarity(vmsCompact,productCompact);
   const containment=vmsCompact&&productCompact&&(vmsCompact.includes(productCompact)||productCompact.includes(vmsCompact));
   score=Math.max(editScore,tokenScore,containment?Math.min(.9,.72+.06*Math.min(vmsTokens.size,productTokens.size)):0);
   if(tokenScore>=.75)reason="Strong name-token match";
   else if(containment)reason="Product name contained in the other name";
   else if(editScore>=.72)reason="Close spelling";
   else reason="Weak name similarity";
  }
  if(!best||score>best.score)best={product,score,reason};
 }
 if(!best||best.score<.72)return null;
 return {...best,confidence:Math.round(best.score*100)};
}
