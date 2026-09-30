// Стили интерфейса. CSS-переходы — только у панелей, не привязанных к камере.

export const STYLE = `
:root{--bg:#f4efe4;--ink:#2b2622;--mut:#7a6f63;--acc:#b5532f;--line:#d8cfbf;--ok:#3d7a4f}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;height:100%;overflow:hidden;overscroll-behavior:none;font:14px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:#b8cfdb;user-select:none;-webkit-user-select:none}
#map{position:fixed;inset:0;touch-action:none;overflow:hidden}
#map canvas{position:absolute;inset:0;width:100%;height:100%}
.layer{position:absolute;inset:0;pointer-events:none}
.layer>*{position:absolute;left:0;top:0;will-change:transform}
.nd i{position:absolute;left:-3px;top:-3px;width:6px;height:6px;border-radius:50%;background:#3a332c;box-shadow:0 0 0 1.5px #fff8}
.nd.sea i{background:#fff;box-shadow:0 0 0 1.5px #4a6a7d}
.nd.port i{border-radius:1px}
.nd span{position:absolute;left:8px;top:-8px;white-space:nowrap;font-size:11px;text-shadow:0 0 3px #fff,0 0 3px #fff}
.nd.sea span{font-style:italic;color:#3d5a6b}
.nd.p3 span{font-weight:600;font-size:12px}
.nd.tgt i{width:14px;height:14px;left:-7px;top:-7px;background:#fff;box-shadow:0 0 0 2.5px var(--acc)}
.rl{margin:-8px 0 0 -60px;width:120px;text-align:center;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#4a4036b0;white-space:nowrap}
.rl{width:auto;margin:0;transform-origin:0 0}
.hide span,.rl.hide{visibility:hidden}
.mk{pointer-events:auto;margin:-14px 0 0 -14px;width:28px;height:28px;border-radius:50%;border:2px solid #2b2622;background:var(--c,#ddd);font:600 13px/1 inherit;color:#2b2622;padding:0;cursor:pointer;box-shadow:0 1px 3px #0005}
.mk::after{content:"";position:absolute;inset:-10px}
.mk.own{border-color:#7a2f14}
.mk.own:not(.free){opacity:.8;border-style:dashed}
.mk.foreign{border-radius:6px}
.mk.unknown{border-style:dotted;background:#eee}
.mk.a1{opacity:.75}.mk.a2{opacity:.55}.mk.a3{opacity:.4}
.mk.st{box-shadow:0 0 0 3px #b5532f66,0 1px 3px #0005}
.mk.sel{outline:3px solid var(--acc);outline-offset:2px}
.mk.drag{opacity:.85;box-shadow:0 6px 14px #0006;z-index:5}
#top{position:fixed;left:0;right:0;top:0;padding:calc(6px + env(safe-area-inset-top)) 10px 6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:linear-gradient(#f4efe4f2,#f4efe4cc);border-bottom:1px solid var(--line);font-size:12px;pointer-events:none}
#top b{font-size:13px}
.chip{padding:1px 7px;border-radius:9px;background:#fff9;border:1px solid var(--line);white-space:nowrap}
.chip.warn{border-color:var(--acc);color:var(--acc)}
.dots i{display:inline-block;width:8px;height:8px;border-radius:50%;border:1.5px solid var(--ink);margin-left:2px}
.dots i.on{background:var(--ink)}.dots i.res{background:var(--acc);border-color:var(--acc)}
#sheet{position:fixed;left:0;right:0;bottom:0;min-height:120px;max-height:120px;max-width:560px;margin:0 auto;background:var(--bg);border-radius:14px 14px 0 0;box-shadow:0 -2px 14px #0003;display:flex;flex-direction:column;padding-bottom:env(safe-area-inset-bottom)}
#sheet.open{max-height:min(62vh,520px)}
.grip{flex:none;height:18px;cursor:pointer}
.grip::after{content:"";display:block;width:38px;height:4px;border-radius:2px;background:var(--line);margin:7px auto}
.body{flex:1;overflow-y:auto;padding:0 12px 8px;overscroll-behavior:contain}
.tabs{flex:none;display:flex;border-top:1px solid var(--line)}
.tabs button{flex:1;border:0;background:none;padding:9px 2px;font:inherit;font-size:13px;white-space:nowrap;color:var(--mut);min-height:44px}
.tabs button.on{color:var(--ink);font-weight:600;box-shadow:inset 0 2px var(--acc)}
h3{margin:2px 0 6px;font-size:15px}
h4{margin:10px 0 4px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--mut)}
p{margin:4px 0}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0}
.btn{min-height:44px;padding:8px 14px;border-radius:10px;border:1px solid var(--line);background:#fff;font:inherit;color:var(--ink);cursor:pointer;text-align:left}
.btn.pri{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:600}
a.btn{text-decoration:none;display:inline-flex;align-items:center}
.btn:disabled{opacity:.5}
.btn.sm{min-height:32px;padding:4px 10px;border-radius:8px}
.btn.on{border-color:var(--acc);box-shadow:inset 0 0 0 1px var(--acc)}
.item{border-top:1px solid var(--line);padding:7px 0}
.item:first-of-type{border-top:0}
.rep b{display:block;height:1.35em;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.rep .f{height:2.7em;overflow:hidden;color:var(--mut);font-size:13px}
.rep .lit{margin-top:6px;white-space:pre-wrap;font-family:Georgia,serif;user-select:text;-webkit-user-select:text}
.tag{font-size:11px;color:var(--acc);margin-left:6px}
.mut{color:var(--mut)}.warn{color:var(--acc)}.ok{color:var(--ok)}
#toast{position:fixed;left:50%;top:64px;transform:translateX(-50%);max-width:90vw;padding:8px 14px;border-radius:10px;background:#2b2622;color:#fff;font-size:13px;display:none;z-index:9}
#toast.on{display:block}
#start{position:fixed;inset:0;background:var(--bg);overflow:auto;padding:24px 16px;display:flex;flex-direction:column;align-items:center;z-index:8}
#start>div{max-width:460px;width:100%}
#start h1{font:600 28px/1.1 Georgia,serif;margin:12px 0 4px}
`;
