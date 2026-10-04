export function youtubeUrl(value:unknown):string{
 if(typeof value!=="string"||!value.trim())return "";
 try{const u=new URL(value.trim());if(u.protocol!=="https:"&&u.protocol!=="http:")return "";
 const host=u.hostname.toLowerCase();let id="";
 if(host==="youtu.be")id=u.pathname.slice(1).split("/")[0];
 else if(["youtube.com","www.youtube.com","m.youtube.com","music.youtube.com"].includes(host)){id=u.pathname==="/watch"?(u.searchParams.get("v")||""):u.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)\/?$/)?.[1]||""}
 if(!/^[a-zA-Z0-9_-]{11}$/.test(id))return "";
 const result=new URL("https://www.youtube.com/watch");result.searchParams.set("v",id);const t=u.searchParams.get("t")||u.searchParams.get("start");if(t&&/^\d+(?:h\d+m\d+s|m\d+s|s)?$/.test(t))result.searchParams.set("t",t);return result.toString();
 }catch{return ""}
}
