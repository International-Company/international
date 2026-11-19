import { SPLASH } from './_shell/brand';
import { AppSplashDone } from './app-splash-done';

/**
 * The opening screen of the installed app.
 *
 * The phone shows its own first — the emblem on the navy, drawn by Android from
 * the manifest and by iOS from a picture for its screen — and this takes over
 * the moment the page paints, with the emblem in the very same place at the
 * very same size, so the hand-over is not seen. It stays while the first
 * screen loads, then fades away.
 *
 * Markup and styles are in the page itself, not in the stylesheet or in React:
 * they have to be on screen with the first paint, before any code has run.
 *
 * Only in the installed app, and once per launch: a tab in a browser has no
 * opening, and a reload for an update is not one either.
 */

const SEEN_KEY = 'international.splash';

const css = `
#app-splash{display:none}
@media (display-mode: standalone), (display-mode: fullscreen) {
  #app-splash{display:block}
}
html.as-standalone #app-splash{display:block}
html.as-seen #app-splash,#app-splash.as-gone{display:none!important}
#app-splash{
  position:fixed;inset:0;z-index:2147483647;overflow:hidden;
  background:radial-gradient(75% 75% at 50% 50%, ${SPLASH.centre} 0%, ${SPLASH.edge} 100%);
  color:#fff;
  transition:opacity .45s ease, visibility .45s ease;
  animation:as-failsafe .45s ease 8s forwards;
}
#app-splash.as-leaving{opacity:0;visibility:hidden}
#app-splash .as-glow{
  position:absolute;left:50%;top:50%;width:${Math.round(SPLASH.emblem * 1.9)}px;height:${Math.round(SPLASH.emblem * 1.9)}px;
  transform:translate(-50%,-50%);border-radius:9999px;
  background:radial-gradient(closest-side, rgba(91,140,255,.35), rgba(91,140,255,0));
  animation:as-breathe 2.4s ease-in-out infinite;
}
#app-splash .as-mark{
  position:absolute;left:50%;top:50%;width:${SPLASH.emblem}px;height:${SPLASH.emblem}px;
  transform:translate(-50%,-50%);border-radius:9999px;
  box-shadow:0 18px 48px -12px rgba(0,0,0,.55);
}
#app-splash .as-words{
  position:absolute;left:0;right:0;top:calc(50% + ${SPLASH.emblem / 2 + 30}px);
  text-align:center;opacity:0;transform:translateY(8px);
  animation:as-rise .6s cubic-bezier(.2,.7,.2,1) .15s forwards;
}
#app-splash .as-name{font-size:24px;font-weight:700;letter-spacing:0;line-height:1.3}
#app-splash .as-sub{margin-top:6px;font-size:13px;font-weight:400;color:rgba(255,255,255,.62)}
#app-splash .as-bar{
  position:absolute;left:50%;bottom:calc(56px + env(safe-area-inset-bottom));
  width:120px;height:3px;margin-left:-60px;border-radius:9999px;overflow:hidden;
  background:rgba(255,255,255,.14);
}
#app-splash .as-bar span{
  position:absolute;top:0;bottom:0;width:40%;border-radius:9999px;
  background:linear-gradient(90deg, rgba(255,255,255,0), #fff, rgba(255,255,255,0));
  animation:as-slide 1.1s ease-in-out infinite;
}
@keyframes as-breathe{0%,100%{opacity:.7;transform:translate(-50%,-50%) scale(.96)}50%{opacity:1;transform:translate(-50%,-50%) scale(1.04)}}
@keyframes as-rise{to{opacity:1;transform:none}}
@keyframes as-slide{0%{left:-40%}100%{left:100%}}
@keyframes as-failsafe{to{opacity:0;visibility:hidden}}
@media (prefers-reduced-motion: reduce){
  #app-splash .as-glow,#app-splash .as-bar span{animation:none}
  #app-splash .as-words{animation:none;opacity:1;transform:none}
}
`;

/*
 * Before the splash is parsed: shown already this launch, it is not shown again;
 * iOS before 15 says "standalone" only through `navigator.standalone`.
 */
const script = `
(function(){try{
  var root=document.documentElement;
  if(navigator.standalone)root.classList.add('as-standalone');
  if(sessionStorage.getItem(${JSON.stringify(SEEN_KEY)}))root.classList.add('as-seen');
  else sessionStorage.setItem(${JSON.stringify(SEEN_KEY)},'1');
}catch(e){}})();`.trim();

export function AppSplash() {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <script dangerouslySetInnerHTML={{ __html: script }} suppressHydrationWarning />
      <div id="app-splash" aria-hidden="true" suppressHydrationWarning>
        <div className="as-glow" />
        {/* eslint-disable-next-line @next/next/no-img-element -- painted before any code runs */}
        <img className="as-mark" src={SPLASH.mark} alt="" width={SPLASH.emblem} height={SPLASH.emblem} fetchPriority="high" />
        <div className="as-words">
          <div className="as-name">انترنشونال</div>
          <div className="as-sub">للخدمات المالية والمجوهرات</div>
        </div>
        <div className="as-bar">
          <span />
        </div>
      </div>
      <AppSplashDone />
    </>
  );
}
