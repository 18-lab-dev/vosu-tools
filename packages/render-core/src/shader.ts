/** Texels per row of the frame table texture (the shader's `frameUV`). */
export const FRAME_TABLE_WIDTH = 1024;
export const shader = /* wgsl */ `
struct Globals { viewport:vec4f, timing:vec4f, cursor:vec4f, keys:vec4f, flags:vec4f, extra:vec4f }
@group(0) @binding(0) var<uniform> g:Globals;
@group(0) @binding(1) var atlas:texture_2d_array<f32>;
@group(0) @binding(2) var atlasSampler:sampler;
@group(0) @binding(3) var frameTable:texture_2d<f32>;
// The frame table (skin.ts buildAtlas): two texels per entry, FRAME_TABLE_WIDTH texels per row.
fn frameUV(i:u32)->vec4f{return textureLoad(frameTable,vec2u(i%${FRAME_TABLE_WIDTH}u,i/${FRAME_TABLE_WIDTH}u),0);}
struct Vertex { @builtin(position) position:vec4f, @location(0) local:vec2f, @location(1) colour:vec4f, @location(2) uv:vec2f, @location(3) shape:vec4f, @location(4) world:vec2f, @location(5) region:vec4f, @location(6) @interpolate(flat) layer:u32 }
fn easeOut(t:f32)->f32{return 1.0-(1.0-t)*(1.0-t);}
fn easeOutQuint(t:f32)->f32{let u=1.0-t;return 1.0-u*u*u*u*u;}
// SpinnerRotationTracker's damped rotation (half-life base 0.99 per ms) of
// autoplay's 0.05 rad/ms spin from s to e, in radians.
fn spinnerTurn(now:f32,s:f32,e:f32)->f32{let w=0.05;let tau=99.4992;if(now<=s){return 0.0;}let t=min(now,e)-s;let r=w*(t-tau*(1.0-exp(-t/tau)));if(now<=e){return r;}let goal=w*(e-s);return goal-(goal-r)*exp(-(now-e)/tau);}
fn outElastic(t:f32)->f32{if(t<=0.0){return 0.0;}if(t>=1.0){return 1.0;}return pow(2.0,-10.0*t)*sin((t-0.075)*6.2831853/0.3)+1.0;}
// LegacyJudgementPieceOld's hit pop: 0.6 to 1.1 (96 ms), held to 120 ms, 0.9
// at 144 ms, then 0.95 easing to the final scale at 168 ms.
fn chainHit(dt:f32,endScale:f32)->f32{
 if(dt<96.0){return 0.6+0.5*max(dt,0.0)/96.0;}
 if(dt<120.0){return 1.1;}
 if(dt<144.0){return 1.1-0.2*(dt-120.0)/24.0;}
 if(dt<168.0){return 0.95+(endScale-0.95)*(dt-144.0)/24.0;}
 return endScale;}
@vertex fn vs(@builtin(vertex_index) index:u32,@location(0) geometry:vec4f,@location(1) life:vec4f,@location(2) tint:vec4f,@location(3) motion:vec4f,@location(4) uv:vec4f,@location(5) shape:vec4f)->Vertex{
 let corners=array<vec2f,6>(vec2f(-0.5,-0.5),vec2f(0.5,-0.5),vec2f(-0.5,0.5),vec2f(-0.5,0.5),vec2f(0.5,-0.5),vec2f(0.5,0.5));
 let now=g.viewport.x;let kind=u32(motion.x);let mode=u32(g.viewport.w);var centre=geometry.xy;var size=geometry.zw;var alpha=tint.a;var angle=0.0;var bodyV=1.0;
 if(now<life.z||now>life.w){alpha=0.0;}
 if(kind==1u){centre.y=motion.w-(motion.y-g.timing.y)*g.timing.x-size.y*0.5;if(life.y>life.x){centre.y=min(centre.y,motion.w-size.y*0.5);}else if(now>life.x){alpha=0.0;} }
 if(kind==2u || kind==14u){let tailLine=motion.w-(motion.z-g.timing.y)*g.timing.x;let headLine=motion.w-(motion.y-g.timing.y)*g.timing.x;let top=tailLine-geometry.w;let bottom=min(headLine,motion.w)-geometry.y;let full=headLine-geometry.y-top;let span=select(full,max(full,20500.0),kind==14u);centre.y=(top+bottom)*0.5;size.y=max(0.0,bottom-top);bodyV=size.y/max(0.0001,span);}
 if(kind==22u){centre.y=motion.w-(motion.y-g.timing.y)*g.timing.x-geometry.y;if(now>life.x){alpha*=clamp(1.0-(now-life.x)/150.0,0.0,1.0);}}
 if(kind==3u){centre.x=geometry.x+(life.x-now)*motion.y;}
 if(mode==1u && kind==3u && now>life.x){alpha=0.0;}
 if(kind==4u){centre.x=geometry.x+(life.x-now)*motion.y+size.x*0.5;}
 if(kind==5u || kind==40u || kind==41u){centre=mix(geometry.xy,motion.yz,clamp((now-life.x)/max(0.01,life.y-life.x),0.0,1.0));}
 // The legacy slider ball faces the way it travels.
 if(kind==41u){let dir=motion.yz-geometry.xy;if(length(dir)>0.01){angle=atan2(dir.y,dir.x);}}
 if(kind==6u){size*=1.0+3.0*clamp((life.x-now)/g.timing.z,0.0,1.0);}
 if(kind==7u){angle=(now-life.x)*0.006;}
 if(kind==23u){let travel=now*motion.y;centre.x=geometry.x-(travel-floor(travel/motion.z)*motion.z);}
 if(kind==24u){centre.y=geometry.y-(life.x-now)*g.timing.x;angle=motion.y+(now-life.x)*motion.z;size*=max(0.0,1.0+(now-life.x)*motion.w);}
 if(kind==25u){let dt=max(0.0,now-life.x);centre.x=geometry.x+(life.x-now)*motion.y;let rise=1.0-min(dt/300.0,1.0);let fall=clamp((dt-300.0)/600.0,0.0,1.0);centre.y+=select(-200.0*(1.0-rise*rise),-200.0+600.0*fall*fall,dt>=300.0)*motion.z;let shrink=1.0-min(dt/600.0,1.0);size*=1.0-0.2*(1.0-shrink*shrink);alpha*=clamp(1.0-dt/800.0,0.0,1.0);}
 if(kind==27u){let dt=now-life.x;alpha*=select(clamp(1.0-(dt-120.0)/180.0,0.0,1.0),clamp(dt/120.0,0.0,1.0),dt<120.0);if(motion.y>0.5){size*=select(select(select(1.0,0.9+0.1*(dt-144.0)/24.0,dt<168.0),1.1-0.2*(dt-96.0)/48.0,dt<144.0),0.6+0.5*dt/96.0,dt<96.0);}}
 if(kind==28u){alpha*=clamp((now-motion.y)/200.0,0.0,1.0)*clamp(1.0-(now-motion.z)/motion.w,0.0,1.0);}
 if(kind==32u){centre.x=geometry.x+(life.x-now)*motion.y;if(now>life.x){let u=1.0-clamp((now-life.x)/200.0,0.0,1.0);let e=1.0-u*u*u*u*u;size*=1.0+0.4*e;alpha*=1.0-e;}}
 if(kind==33u){angle=motion.w;}
 if(kind==33u || kind==34u){if(now<motion.z){alpha*=clamp((now-motion.y)/200.0,0.0,1.0);}else{let u=1.0-clamp((now-motion.z)/300.0,0.0,1.0);alpha*=clamp((motion.z-motion.y)/200.0,0.0,1.0)*u*u;}if(kind==34u){size*=clamp((life.y-now)/max(1.0,life.y-life.x),0.0,1.0);}}
 if(kind==30u){centre.x=g.cursor.x+motion.y;angle=motion.z;}
 if(kind==31u){centre.x=geometry.x+(life.x-now)*motion.y+size.x*0.5;if(now>life.x){alpha*=clamp(1.0-(now-life.x)/150.0,0.0,1.0);}}
 // Taiko notes left unhit: they scroll on, masked, then fade over motion.z ms.
 if(kind==36u){centre.x=geometry.x+(life.x-now)*motion.y;if(now>life.x){alpha*=clamp(1.0-(now-life.x)/motion.z,0.0,1.0);}}
 // osu!'s legacy spinner parts (osu.ts): life.x/y are the spinner's start and
 // end, motion.y the part's role, motion.z autoplay's completion and motion.w
 // a role parameter. The whole spinner fades in over TimeFadeIn and out over
 // 240 ms after its end.
 var fromRgb=tint.rgb;var toRgb=tint.rgb;var mixRgb=0.0;
 if(kind==37u){let s=life.x;let e=life.y;let fi=400.0*min(1.0,g.timing.z/450.0);let role=u32(motion.y+0.5);
  alpha*=clamp((now-(s-fi))/fi,0.0,1.0);if(now>e){alpha*=clamp(1.0-(now-e)/240.0,0.0,1.0);}
  let progress=clamp((now-s)/max(0.01,motion.z-s),0.0,1.0);
  if(role==1u || role==8u){angle=spinnerTurn(now,s,e)*motion.w;}
  if(role==2u){size*=mix(1.0,0.0625/1.1625,clamp((now-s)/max(1.0,e-s),0.0,1.0));}
  if(role==3u){let dt=now-life.z;alpha*=easeOut(clamp(dt/400.0,0.0,1.0));if(now>e-50.0){alpha*=clamp((e-now)/50.0,0.0,1.0);}size*=select(0.8+0.2*clamp((dt-240.0)/160.0,0.0,1.0),2.0-1.2*easeOut(clamp(dt/240.0,0.0,1.0)),dt<240.0);}
  if(role==4u){let half=fi*0.5;alpha*=clamp((now-(s-half))/half,0.0,1.0);}
  if(role==5u){alpha*=clamp(1.0-(now-motion.w)/300.0,0.0,1.0);}
  if(role==6u){centre.y+=50.0*(1.0-easeOut(clamp((now-(s-fi))/fi,0.0,1.0)));}
  if(role>=8u){size*=0.8+0.2*easeOut(progress);}
  if(role==9u){alpha*=progress;if(now>e){alpha*=clamp(1.0-(now-e)/300.0,0.0,1.0);}fromRgb=vec3f(1.0);mixRgb=clamp((now-motion.w)/200.0,0.0,1.0);}
  if(role==10u){toRgb=vec3f(1.0,0.0,0.0);mixRgb=clamp((now-s)/max(1.0,e-s),0.0,1.0);}
 }
 // The legacy follow circle (osu.ts followEvents): tint.r is the segment's
 // event time, tint.g its type (press, tick pop, end), tint.b the slider's
 // remaining time (press) or the scale it starts from (end). Drawn white.
 if(kind==40u){let dt=now-tint.r;let phase=u32(tint.g+0.5);var k=2.0;
  if(phase==0u){k=1.0+easeOut(clamp(dt/max(0.001,min(180.0,tint.b)),0.0,1.0));alpha*=clamp(dt/max(0.001,min(60.0,tint.b)),0.0,1.0);}
  if(phase==1u){k=2.2-0.2*clamp(dt/200.0,0.0,1.0);}
  if(phase==2u){let u=clamp(dt/200.0,0.0,1.0);k=tint.b+(1.6-tint.b)*easeOut(u);alpha*=(1.0-u*u)*clamp(1.0-dt/240.0,0.0,1.0);}
  size*=k;}
 // Judgements, hit lighting and explosions (judgements.ts): motion.y picks
 // the transform sequence of the lazer piece, from the result time life.x.
 if(kind==35u){let dt=now-life.x;let profile=u32(motion.y+0.5);let animated=shape.z>1.0;
  let in120=clamp(dt/120.0,0.0,1.0);let out500=clamp(1.0-(dt-500.0)/600.0,0.0,1.0);
  if(profile==0u || profile==4u){alpha*=in120*out500;if(!animated || profile==4u){size*=chainHit(dt,motion.w);}
   if(profile==4u){let half=select(0.5*(1.0-(dt-40.0)/300.0),0.5*easeOut(clamp((dt+16.0)/56.0,0.0,1.0)),dt<40.0);alpha*=max(0.0,half);}}
  if(profile==1u){alpha*=in120*out500;if(!animated){let t=clamp(dt/100.0,0.0,1.0);size*=1.6-0.6*t*t;
   let late=clamp((dt-120.0)/980.0,0.0,1.0);angle=motion.z*select(1.0+late*late,in120,dt<120.0);
   let fall=clamp(dt/1100.0,0.0,1.0);centre.y+=motion.w*(-5.0+80.0*fall*fall);}}
  if(profile==2u){alpha*=in120*clamp(1.0-(dt-250.0)/600.0,0.0,1.0);if(!animated){let t=clamp(dt/100.0,0.0,1.0);size*=1.2-0.2*t*t;}}
  if(profile==3u){alpha*=in120*out500;if(!animated){size*=0.9+0.15*clamp(dt/1100.0,0.0,1.0);}}
  if(profile==5u){alpha*=select(clamp(1.0-(dt-400.0)/1000.0,0.0,1.0),clamp(dt/200.0,0.0,1.0),dt<400.0);size*=0.8+0.4*easeOut(clamp(dt/600.0,0.0,1.0));}
  if(profile==6u){centre.y-=10.0*motion.z*easeOut(clamp(dt/300.0,0.0,1.0));alpha*=clamp(1.0-(dt-300.0)/60.0,0.0,1.0);}
  if(profile==7u || profile==8u){let late=clamp((dt-180.0)/40.0,0.0,1.0);alpha*=easeOut(clamp(dt/20.0,0.0,1.0))*(1.0-late*late);
   if(profile==7u){size*=select(select(select(0.7-0.3*late*late,0.7,dt<180.0),0.85-0.15*(dt-40.0)/40.0,dt<80.0),0.8+0.2*dt/40.0,dt<40.0);}
   else{let t=easeOut(clamp(dt/100.0,0.0,1.0));size*=1.2-0.2*t;angle=motion.z*t;}}
  if(profile==9u){alpha*=select(clamp(1.0-(dt-80.0)/120.0,0.0,1.0),clamp(dt/80.0,0.0,1.0),dt<80.0);}
  if(profile==10u){alpha*=select(clamp(1.0-(dt-120.0)/180.0,0.0,1.0),in120,dt<120.0);
   if(!animated){size*=select(select(select(1.0,0.9+0.1*(dt-144.0)/24.0,dt<168.0),1.1-0.2*(dt-96.0)/48.0,dt<144.0),0.6+0.5*dt/96.0,dt<96.0);}
   if(motion.z>0.0){let second=easeOutQuint(clamp((now-motion.z)/50.0,0.0,1.0));alpha*=select(1.0-second,second,motion.w>0.5);}}
  if(profile==11u || profile==12u){
   if(profile==11u){let e=easeOut(clamp(dt/160.0,0.0,1.0));alpha*=clamp(1.0-dt/300.0,0.0,1.0);size=vec2f(geometry.z*(0.9+0.2*e),geometry.w*(1.0+(motion.z-1.0)*e));}
   else{alpha*=clamp(1.0-dt/700.0,0.0,1.0);size=vec2f(geometry.z*(1.0+0.3*easeOut(clamp(dt/500.0,0.0,1.0))),geometry.w*0.9);}
   centre.y=geometry.y-size.y*0.5;if(dt>=700.0){alpha=0.0;}}
  var group=1.0;
  if(profile>=13u && profile<=15u){let since=now-motion.z;
   alpha*=select(1.0,clamp(1.0-(since-1000.0)/300.0,0.0,1.0),since>1000.0)*select(1.0,1.0-easeOut(clamp((now-motion.w)/400.0,0.0,1.0)),now>motion.w);
   if(profile==13u){group=1.5-0.7*easeOut(clamp(dt/250.0,0.0,1.0));}
   if(profile==14u){group=select(select(1.0,1.1-0.1*(dt-60.0)/30.0,dt<90.0),1.0+0.1*dt/60.0,dt<60.0);}
   if(profile==15u){group=1.5+0.4*easeOut(clamp(dt/400.0,0.0,1.0));alpha*=clamp(1.0-dt/400.0,0.0,1.0);}
   size*=group;}
  // Catch lighting and the combo counter ride on the catcher: x is an offset.
  // Digits scale about the counter's centre, so their offsets scale too.
  if(profile>=11u && profile<=15u){centre.x=g.cursor.x+geometry.x*group;}
  // DefaultManiaJudgementPiece hits: 0.8 springing towards 1 (out elastic),
  // then from 50 ms easing to 0.75 over 250 ms while fading over 200 ms.
  if(profile==18u){let pop=0.8+0.2*outElastic(clamp(min(dt,50.0)/250.0,0.0,1.0));
   size*=select(pop,mix(pop,0.75,clamp((dt-50.0)/250.0,0.0,1.0)),dt>50.0);alpha*=clamp(1.0-(dt-50.0)/200.0,0.0,1.0);}
  // DefaultJudgementPiece (built-in triangles / argon looks): fades over 800 ms;
  // misses drop 100 units and turn 40 degrees (in quint), popping 1.6 to 1.
  if(profile==17u){alpha*=clamp(1.0-dt/800.0,0.0,1.0);
   // osu!'s piece also widens hits from 0.8 to 1.2 over 1800 ms (out quint).
   if(motion.z>1.5){size.x*=0.8+0.4*easeOutQuint(clamp(dt/1800.0,0.0,1.0));}
   if(motion.z>0.5 && motion.z<1.5){let t=clamp(dt/100.0,0.0,1.0);let q=clamp(dt/800.0,0.0,1.0);let quint=q*q*q*q*q;
   size*=1.6-0.6*t*t;centre.y+=100.0*motion.w*quint;angle=0.6981317*quint;}}
  if(profile==16u){let duration=floor(motion.z/8.0);let direction=motion.z-duration*8.0;let progress=clamp((dt+100.0)/duration,0.0,1.0);
   centre+=motion.w*progress*vec2f(sin(direction),cos(direction));alpha*=in120*out500*clamp(1.0-(dt+100.0)/1600.0,0.0,1.0)*(1.0-progress);}
  // Replay-input elements (gameplay.ts, taiko.ts, fruits.ts).
  // LegacyHalfDrum: FadeTo(1, 80 × (1 - alpha), out quad) from the alpha
  // at the press (motion.z), then 100 ms in a 50 ms fade out.
  if(profile==19u){let down=80.0*(1.0-motion.z);var a=1.0;if(dt<down){let t=dt/down;a=motion.z+(1.0-motion.z)*(1.0-(1.0-t)*(1.0-t));}
   alpha*=a*clamp(1.0-(dt-100.0)/50.0,0.0,1.0);}
  // LegacyKiaiGlow: 100 ms in from the kiai start (motion.z), 600 ms out
  // after its end (motion.w); a hit (any segment after the start) pops the
  // scale 0.8 + 0.15 back to 0.8 over 80 ms (out quad).
  if(profile==20u){alpha*=clamp((now-motion.z)/100.0,0.0,1.0)*select(1.0,clamp(1.0-(now-motion.w)/600.0,0.0,1.0),now>motion.w);
   if(life.x>motion.z+0.01){let t=clamp(dt/80.0,0.0,1.0);size*=1.0+0.1875*(1.0-(1.0-(1.0-t)*(1.0-t)));}}
  // Catcher.applyDropAnimation: Drop falls 75 over 750 ms (in sine); Explode
  // rises 50 over 250 ms (out sine), falls 100 over 500 ms (in sine) and
  // travels motion.z over 1000 ms; both fade over 750 ms. motion.w: angle.
  if(profile==22u || profile==23u){angle=motion.w;let f=clamp(dt/750.0,0.0,1.0);alpha*=1.0-f;
   if(profile==22u){centre.y+=75.0*(1.0-cos(f*1.5707963));}
   else{centre.y+=select(-50.0+100.0*(1.0-cos(clamp((dt-250.0)/500.0,0.0,1.0)*1.5707963)),-50.0*sin(clamp(dt/250.0,0.0,1.0)*1.5707963),dt<250.0);
    centre.x+=motion.z*clamp(dt/1000.0,0.0,1.0);}}
  // CatcherTrail: dash trails FadeTo(0.4).FadeOut(800, out quint).
  if(profile==24u){alpha*=0.4*(1.0-easeOutQuint(clamp(dt/800.0,0.0,1.0)));}
  // Hyper-dash after-image: 10 up and 0.95 → 1.14 (ScaleTo(Scale × 1.2) after
  // ScaleTo(Scale × 0.95) applied) about the catcher's top (motion.z) over
  // 1200 ms (in quad), fading linearly.
  if(profile==25u){let e=clamp(dt/1200.0,0.0,1.0);let q=e*e;let k=0.95+0.19*q;
   centre.y=motion.z+(geometry.y-motion.z)*k-10.0*q;size*=k;alpha*=1.0-e;}
  // LegacyColumnBackground: on release (motion.z) the light fades and
  // shrinks to its bottom over 250 ms.
  if(profile==26u && now>motion.z){let t=clamp((now-motion.z)/250.0,0.0,1.0);alpha*=1.0-t;size.y*=1.0-t;
   centre.y=geometry.y+geometry.w*0.5-size.y*0.5;}
  // Per-frame sprites (the osu! cursor): turned by motion.z.
  if(profile==27u){angle=motion.z;}
 }
 if(kind==9u || (kind>=15u && kind<=17u)){centre.x=g.cursor.x;}if(kind>=15u && kind<=17u){if(u32(g.flags.w)!=kind-15u){alpha=0.0;}if(g.cursor.w<0.0){size.x=-size.x;}}
 if(kind==10u){size*=clamp((life.y-now)/max(1.0,life.y-life.x),0.0,1.0);}
 if(kind>=11u && kind<=13u){let pressed=(u32(select(g.keys.x,g.extra.y,kind!=13u))&(1u<<u32(motion.y)))!=0u;if((kind==11u && pressed) || (kind!=11u && !pressed)){alpha=0.0;}}
 if(kind==18u || kind==19u){let bit=1u<<u32(motion.y);let pressed=(u32(g.keys.x)&bit)!=0u;let held=(u32(g.keys.y)&bit)!=0u;if(!pressed || (kind==18u && held) || (kind==19u && !held)){alpha=0.0;}}
 if(mode==0u && life.z > -1e8 && kind!=5u && kind!=35u && kind!=37u && kind!=40u && kind!=41u){alpha*=clamp((now-life.z)/min(400.0,g.timing.z*0.4),0.0,1.0);if(now>life.y){alpha*=clamp(1.0-(now-life.y)/180.0,0.0,1.0);}}
 if(mode!=0u && life.z > -1e8 && now>life.y && kind!=35u){alpha*=clamp(1.0-(now-life.y)/120.0,0.0,1.0);}
 if(g.flags.x>0.0 && life.z > -1e8 && kind!=35u && kind!=37u && kind!=40u && kind!=41u){if(mode==0u){alpha*=clamp((life.x-now-g.timing.z*0.3)/(g.timing.z*0.3),0.0,1.0);}else if(mode==3u){alpha*=clamp((motion.w-centre.y-motion.w*0.15)/(motion.w*0.25),0.0,1.0);}else if(kind==3u || kind==4u || kind==24u){alpha*=clamp((life.x-now)/400.0,0.0,1.0);}}
 if(g.flags.y>0.0 && mode==3u && life.z > -1e8 && kind!=35u){alpha*=clamp((centre.y-motion.w*0.3)/(motion.w*0.3),0.0,1.0);}
 if(g.flags.z>0.0 && mode==3u){centre.y=384.0-centre.y;}
 if((kind==0u && (shape.x==2.0 || shape.x==12.0)) || shape.x==3.0){angle=motion.y;}
 var code=shape.x;var flipV=false;let up=g.flags.z>0.0 && mode==3u;if(shape.x>=40.0){flipV=(shape.x==40.0 && up) || (shape.x==41.0 && !up);code=select(10.0,13.0,shape.x==42.0);}
 // Frame table: (uv) then (a, b, layer, stride) per entry; [a, b] are the image rows an entry (one strip of a tall image) holds.
 // An animated instance's uv slot carries a centred crop as (_, _, -w, -h) fractions (strips crop horizontally only).
 var selected=uv;var layer=0u;var rows=vec2f(0.0,1.0);if(code==10.0 || code==13.0){var at=u32(shape.y);if(shape.z>=1.0){let origin=select(life.x,motion.w,kind==5u || kind==40u || kind==41u);let raw=u32(max(0.0,now-origin)*abs(shape.w)/1000.0);let once=kind==35u && motion.y!=7.0 && motion.y!=8.0 && motion.y!=26.0;let frame=select(raw%u32(shape.z),min(raw,u32(shape.z)-1u),once);at+=frame*u32(max(1.0,frameUV(at*2u+1u).w));selected=frameUV(at*2u);}let info=frameUV(at*2u+1u);rows=info.xy;layer=u32(info.z);if(shape.z>=1.0 && uv.z<0.0){let crop=-uv.zw;let whole=rows.x<=0.0 && rows.y>=1.0;selected=vec4f(selected.x+selected.z*(1.0-crop.x)*0.5,select(selected.y,selected.y+selected.w*(1.0-crop.y)*0.5,whole),selected.z*crop.x,select(selected.w,selected.w*crop.y,whole));}}
 // The quad shows image rows [0, bodyV] (upside down when flipped); a strip covers only its own rows of that.
 let visible=max(bodyV,0.000001);var t0=0.0;var t1=1.0;if(rows.x>0.0 || rows.y<1.0){let lo=clamp(rows.x,0.0,visible);let hi=clamp(rows.y,0.0,visible);if(hi<=lo){alpha=0.0;}t0=select(lo,visible-hi,flipV)/visible;t1=select(hi,visible-lo,flipV)/visible;}
 let t=mix(t0,t1,corners[index].y+0.5);
 let local=vec2f(corners[index].x*size.x,(t-0.5)*size.y);let rotated=vec2f(local.x*cos(angle)-local.y*sin(angle),local.x*sin(angle)+local.y*cos(angle));let point=centre+rotated;
 let scale=min(g.viewport.y/640.0,g.viewport.z/480.0);let screen=(point+vec2f(0.0,select(0.0,g.extra.x,mode==0u))-vec2f(256.0,192.0))*scale;
 let row=select(t,1.0-t,flipV)*bodyV;let stripV=(row-rows.x)/max(0.000001,rows.y-rows.x);
 var result:Vertex;result.position=vec4f(screen.x/g.viewport.y*2.0,-screen.y/g.viewport.z*2.0,0.0,1.0);if(alpha<=0.0){result.position=vec4f(2.0,2.0,0.0,1.0);}result.local=corners[index]*2.0;var rgb=tint.rgb;if(kind>=15u && kind<=17u){let lin=select(pow((tint.rgb+0.055)/1.055,vec3f(2.4)),tint.rgb/12.92,tint.rgb<=vec3f(0.04045));let mixed=mix(vec3f(1.0),lin,g.keys.z);rgb=select(1.055*pow(mixed,vec3f(1.0/2.4))-0.055,mixed*12.92,mixed<=vec3f(0.0031308));}
 // FadeColour / FlashColour mix in linear light.
 if(mixRgb>0.0){let a=select(pow((fromRgb+0.055)/1.055,vec3f(2.4)),fromRgb/12.92,fromRgb<=vec3f(0.04045));let b=select(pow((toRgb+0.055)/1.055,vec3f(2.4)),toRgb/12.92,toRgb<=vec3f(0.04045));let mixed=mix(a,b,mixRgb);rgb=select(1.055*pow(mixed,vec3f(1.0/2.4))-0.055,mixed*12.92,mixed<=vec3f(0.0031308));}
 else if(kind==37u){rgb=fromRgb;}
 if(kind==40u){rgb=vec3f(1.0);}result.colour=vec4f(rgb,alpha);result.uv=vec2f(selected.x+(corners[index].x+0.5)*selected.z,selected.y+stripV*selected.w);result.layer=layer;result.shape=vec4f(code,size.x/max(0.01,size.y),shape.y,f32(kind));result.world=point;result.region=selected;return result;
}
@fragment fn fs(v:Vertex)->@location(0) vec4f{
 let shape=u32(v.shape.x);let d=length(v.local);var colour=v.colour;var coverage=1.0;let aa=max(fwidth(d),0.005);
 if(u32(g.viewport.w)==3u && (v.world.y< -48.0 || v.world.y>432.0)){discard;}
 if(u32(g.viewport.w)==1u && (u32(v.shape.w)==3u || u32(v.shape.w)==4u || u32(v.shape.w)==32u || u32(v.shape.w)==36u) && v.world.x<g.timing.w){discard;}
 if(shape==0u){coverage=1.0-smoothstep(1.0-aa,1.0,d);colour=vec4f(colour.rgb*(0.75+0.25*clamp(1.0-v.local.y,0.0,1.0)),colour.a);}
 if(shape==1u){coverage=(1.0-smoothstep(1.0-aa,1.0,d))*smoothstep(0.85-aa,0.85,d);}
 if(shape==2u){let p=vec2f(v.local.x*v.shape.y,v.local.y);let q=p-vec2f(clamp(p.x,-v.shape.y+1.0,v.shape.y-1.0),0.0);coverage=1.0-smoothstep(1.0-aa,1.0,length(q));}
 if(shape==3u){let x=v.local.x;let y=abs(v.local.y);coverage=select(0.0,1.0,x>-0.8 && x<0.8 && y<(0.8-x)*0.6 && y>(0.2-x)*0.6);}
 if(shape==5u){let a=length((v.local-vec2f(-0.2,0.1))/vec2f(0.7,0.8));let b=length((v.local-vec2f(0.2,0.1))/vec2f(0.7,0.8));coverage=1.0-smoothstep(1.0-aa,1.0,min(a,b));}
 if(shape==6u){var nearest=10.0;for(var i=0u;i<6u;i++){let row=select(0.0,0.55,i>2u);let x=f32(i%3u)*0.55-0.55;nearest=min(nearest,length(v.local-vec2f(x,row-0.3))/0.4);}coverage=1.0-smoothstep(1.0-aa,1.0,nearest);}
 if(shape==8u){let outer=length(v.local-vec2f(-0.15,-0.3));let inner=length(v.local-vec2f(0.15,-0.5));coverage=(1.0-smoothstep(1.0-aa,1.0,outer))*smoothstep(0.74-aa,0.74,inner);}
 if(shape==9u){coverage=1.0-smoothstep(1.0-aa,1.0,d);let rim=smoothstep(0.72,0.78,d);colour=vec4f(mix(vec3f(0.86,0.65,0.5),vec3f(0.45,0.48,0.5),rim),colour.a);if(abs(v.local.x)<0.025){colour=vec4f(0.2,0.2,0.2,colour.a);}}
 if(shape==10u || shape==13u){let tex=textureSampleLevel(atlas,atlasSampler,v.uv,v.layer,0.0);colour=vec4f(tex.rgb*colour.rgb,tex.a*colour.a);}
 if(shape==12u){let p=vec2f(v.local.x*v.shape.y,v.local.y);let q=p-vec2f(clamp(p.x,-v.shape.y+1.0,v.shape.y-1.0),0.0);let r=length(q);coverage=1.0-smoothstep(1.0-aa,1.0,r);
  let shadowPass=v.shape.z>5.0;let border=select(abs(v.shape.z),v.shape.z-10.0,shadowPass);let profile=floor(v.region.w/10.0+0.0001);let bodyAlpha=v.region.w-profile*10.0;let accent=colour.rgb;var c=v.region.rgb;var a=1.0;let shadow=0.078125;
  if(v.shape.z<0.0){let t=1.0-r*(1.0-border);let f=clamp((t-border)/max(0.0001,1.0-border),0.0,1.0);
   if(profile<1.5){c=mix(accent/1.1,min(vec3f(1.0),accent*1.125+0.25),f)*bodyAlpha;}else if(profile<2.5){c=accent*(0.8-0.5*f)*bodyAlpha;}else{c=accent/5.0*bodyAlpha;}}
  else if(shadowPass){let t=1.0-r;c=vec3f(0.0);a=0.25*clamp(t/shadow,0.0,1.0);coverage*=1.0-smoothstep(shadow,shadow+0.02,t);}
  else{let t=1.0-r;if(profile<1.5){coverage*=smoothstep(shadow-0.005,shadow+0.005,t);}coverage*=1.0-smoothstep(border+0.01,border+0.03,t);}
  colour=vec4f(c,colour.a*a);}
 if(shape==11u){let spoke=pow(max(0.0,cos(atan2(v.local.y,v.local.x)*6.0)),8.0);coverage=(1.0-smoothstep(1.0-aa,1.0,d))*max(smoothstep(0.83,0.88,d),spoke*smoothstep(0.25,0.35,d));}
 if(g.cursor.z>0.0){coverage*=1.0-smoothstep(90.0,125.0,distance(v.world,g.cursor.xy));}
 let alpha=colour.a*coverage;if(alpha<0.002){discard;}if(shape==13u){return vec4f(colour.rgb*alpha,0.0);}return vec4f(colour.rgb*alpha,alpha);
}
`;
