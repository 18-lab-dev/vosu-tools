export const shader = /* wgsl */ `
struct Globals { viewport:vec4f, timing:vec4f, cursor:vec4f, keys:vec4f, flags:vec4f }
@group(0) @binding(0) var<uniform> g:Globals;
@group(0) @binding(1) var atlas:texture_2d<f32>;
@group(0) @binding(2) var atlasSampler:sampler;
@group(0) @binding(3) var<storage,read> frameUV:array<vec4f>;
struct Vertex { @builtin(position) position:vec4f, @location(0) local:vec2f, @location(1) colour:vec4f, @location(2) uv:vec2f, @location(3) shape:vec4f, @location(4) world:vec2f, @location(5) region:vec4f }
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
 if(kind==5u){centre=mix(geometry.xy,motion.yz,clamp((now-life.x)/max(0.01,life.y-life.x),0.0,1.0));}
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
 if(kind==9u || (kind>=15u && kind<=17u)){centre.x=g.cursor.x;}if(kind>=15u && kind<=17u){if(u32(g.flags.w)!=kind-15u){alpha=0.0;}if(g.cursor.w<0.0){size.x=-size.x;}}
 if(kind==10u){size*=clamp((life.y-now)/max(1.0,life.y-life.x),0.0,1.0);}
 if(kind>=11u && kind<=13u){let pressed=(u32(g.keys.x)&(1u<<u32(motion.y)))!=0u;if((kind==11u && pressed) || (kind!=11u && !pressed)){alpha=0.0;}}
 if(kind==18u || kind==19u){let bit=1u<<u32(motion.y);let pressed=(u32(g.keys.x)&bit)!=0u;let held=(u32(g.keys.y)&bit)!=0u;if(!pressed || (kind==18u && held) || (kind==19u && !held)){alpha=0.0;}}
 if(mode==0u && life.z > -1e8 && kind!=5u){alpha*=clamp((now-life.z)/min(400.0,g.timing.z*0.4),0.0,1.0);if(now>life.y){alpha*=clamp(1.0-(now-life.y)/180.0,0.0,1.0);}}
 if(mode!=0u && life.z > -1e8 && now>life.y){alpha*=clamp(1.0-(now-life.y)/120.0,0.0,1.0);}
 if(g.flags.x>0.0 && life.z > -1e8){if(mode==0u){alpha*=clamp((life.x-now-g.timing.z*0.3)/(g.timing.z*0.3),0.0,1.0);}else if(mode==3u){alpha*=clamp((motion.w-centre.y-motion.w*0.15)/(motion.w*0.25),0.0,1.0);}else if(kind==3u || kind==4u || kind==24u){alpha*=clamp((life.x-now)/400.0,0.0,1.0);}}
 if(g.flags.y>0.0 && mode==3u && life.z > -1e8){alpha*=clamp((centre.y-motion.w*0.3)/(motion.w*0.3),0.0,1.0);}
 if(g.flags.z>0.0 && mode==3u){centre.y=384.0-centre.y;}
 if((kind==0u && (shape.x==2.0 || shape.x==12.0)) || shape.x==3.0){angle=motion.y;}
 let local=corners[index]*size;let rotated=vec2f(local.x*cos(angle)-local.y*sin(angle),local.x*sin(angle)+local.y*cos(angle));let point=centre+rotated;
 let scale=min(g.viewport.y/640.0,g.viewport.z/480.0);let screen=(point-vec2f(256.0,192.0))*scale;
 var code=shape.x;var flipV=false;let up=g.flags.z>0.0 && mode==3u;if(shape.x>=40.0){flipV=(shape.x==40.0 && up) || (shape.x==41.0 && !up);code=select(10.0,13.0,shape.x==42.0);}
 var selected=uv;if((code==10.0 || code==13.0) && shape.z>=1.0){let origin=select(life.x,motion.w,kind==5u);let frame=u32(max(0.0,now-origin)*abs(shape.w)/1000.0)%u32(shape.z);selected=frameUV[u32(shape.y)+frame];}
 var corner=corners[index]+0.5;if(flipV){corner.y=1.0-corner.y;}corner.y*=bodyV;
 var result:Vertex;result.position=vec4f(screen.x/g.viewport.y*2.0,-screen.y/g.viewport.z*2.0,0.0,1.0);if(alpha<=0.0){result.position=vec4f(2.0,2.0,0.0,1.0);}result.local=corners[index]*2.0;var rgb=tint.rgb;if(kind>=15u && kind<=17u){let lin=select(pow((tint.rgb+0.055)/1.055,vec3f(2.4)),tint.rgb/12.92,tint.rgb<=vec3f(0.04045));let mixed=mix(vec3f(1.0),lin,g.keys.z);rgb=select(1.055*pow(mixed,vec3f(1.0/2.4))-0.055,mixed*12.92,mixed<=vec3f(0.0031308));}result.colour=vec4f(rgb,alpha);result.uv=selected.xy+corner*selected.zw;result.shape=vec4f(code,size.x/max(0.01,size.y),shape.y,f32(kind));result.world=point;result.region=selected;return result;
}
@fragment fn fs(v:Vertex)->@location(0) vec4f{
 let shape=u32(v.shape.x);let d=length(v.local);var colour=v.colour;var coverage=1.0;let aa=max(fwidth(d),0.005);
 if(u32(g.viewport.w)==3u && (v.world.y< -48.0 || v.world.y>432.0)){discard;}
 if(u32(g.viewport.w)==1u && (u32(v.shape.w)==3u || u32(v.shape.w)==4u || u32(v.shape.w)==32u) && v.world.x<g.timing.w){discard;}
 if(shape==0u){coverage=1.0-smoothstep(1.0-aa,1.0,d);colour=vec4f(colour.rgb*(0.75+0.25*clamp(1.0-v.local.y,0.0,1.0)),colour.a);}
 if(shape==1u){coverage=(1.0-smoothstep(1.0-aa,1.0,d))*smoothstep(0.85-aa,0.85,d);}
 if(shape==2u){let p=vec2f(v.local.x*v.shape.y,v.local.y);let q=p-vec2f(clamp(p.x,-v.shape.y+1.0,v.shape.y-1.0),0.0);coverage=1.0-smoothstep(1.0-aa,1.0,length(q));}
 if(shape==3u){let x=v.local.x;let y=abs(v.local.y);coverage=select(0.0,1.0,x>-0.8 && x<0.8 && y<(0.8-x)*0.6 && y>(0.2-x)*0.6);}
 if(shape==5u){let a=length((v.local-vec2f(-0.2,0.1))/vec2f(0.7,0.8));let b=length((v.local-vec2f(0.2,0.1))/vec2f(0.7,0.8));coverage=1.0-smoothstep(1.0-aa,1.0,min(a,b));}
 if(shape==6u){var nearest=10.0;for(var i=0u;i<6u;i++){let row=select(0.0,0.55,i>2u);let x=f32(i%3u)*0.55-0.55;nearest=min(nearest,length(v.local-vec2f(x,row-0.3))/0.4);}coverage=1.0-smoothstep(1.0-aa,1.0,nearest);}
 if(shape==8u){let outer=length(v.local-vec2f(-0.15,-0.3));let inner=length(v.local-vec2f(0.15,-0.5));coverage=(1.0-smoothstep(1.0-aa,1.0,outer))*smoothstep(0.74-aa,0.74,inner);}
 if(shape==9u){coverage=1.0-smoothstep(1.0-aa,1.0,d);let rim=smoothstep(0.72,0.78,d);colour=vec4f(mix(vec3f(0.86,0.65,0.5),vec3f(0.45,0.48,0.5),rim),colour.a);if(abs(v.local.x)<0.025){colour=vec4f(0.2,0.2,0.2,colour.a);}}
 if(shape==10u || shape==13u){let tex=textureSampleLevel(atlas,atlasSampler,v.uv,0.0);colour=vec4f(tex.rgb*colour.rgb,tex.a*colour.a);}
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
