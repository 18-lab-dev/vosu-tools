export const shader = /* wgsl */ `
struct Globals { viewport:vec4f, timing:vec4f, cursor:vec4f, keys:vec4f, flags:vec4f }
@group(0) @binding(0) var<uniform> g:Globals;
@group(0) @binding(1) var atlas:texture_2d<f32>;
@group(0) @binding(2) var atlasSampler:sampler;
struct Vertex { @builtin(position) position:vec4f, @location(0) local:vec2f, @location(1) colour:vec4f, @location(2) uv:vec2f, @location(3) shape:vec4f, @location(4) world:vec2f }
@vertex fn vs(@builtin(vertex_index) index:u32,@location(0) geometry:vec4f,@location(1) life:vec4f,@location(2) tint:vec4f,@location(3) motion:vec4f,@location(4) uv:vec4f,@location(5) shape:vec4f)->Vertex{
 let corners=array<vec2f,6>(vec2f(-0.5,-0.5),vec2f(0.5,-0.5),vec2f(-0.5,0.5),vec2f(-0.5,0.5),vec2f(0.5,-0.5),vec2f(0.5,0.5));
 let now=g.viewport.x;let kind=u32(motion.x);let mode=u32(g.viewport.w);var centre=geometry.xy;var size=geometry.zw;var alpha=tint.a;var angle=0.0;
 if(now<life.z||now>life.w){alpha=0.0;}
 if(kind==1u){centre.y=motion.w-(motion.y-g.timing.y)*g.timing.x;if(life.y>life.x){centre.y=min(centre.y,motion.w);}else if(now>life.x){alpha=0.0;} }
 if(kind==2u){let head=min(motion.w,motion.w-(motion.y-g.timing.y)*g.timing.x);let tail=motion.w-(motion.z-g.timing.y)*g.timing.x;centre.y=(head+tail)*0.5;size.y=max(0.0,head-tail);}
 if(kind==3u){centre.x=geometry.x+(life.x-now)*motion.y;}
 if(mode==1u && kind==3u && now>life.x){alpha=0.0;}
 if(kind==4u){centre.x=geometry.x+(life.x-now)*motion.y+size.x*0.5;}
 if(kind==5u){centre=mix(geometry.xy,motion.yz,clamp((now-life.x)/max(0.01,life.y-life.x),0.0,1.0));}
 if(kind==6u){size*=1.0+3.0*clamp((life.x-now)/g.timing.z,0.0,1.0);}
 if(kind==7u){angle=(now-life.x)*0.006;}
 if(kind==8u){centre.y=340.0-(life.x-now)*g.timing.x;}
 if(kind==9u){centre.x=g.cursor.x;}
 if(kind==10u){size*=clamp((life.y-now)/max(1.0,life.y-life.x),0.0,1.0);}
 if(kind==11u){let lane=u32(motion.y);let mask=u32(g.keys.x);if((mask&(1u<<lane))!=0u){alpha=1.0;size.y*=1.2;}}
 if(mode==0u && life.z > -1e8 && kind!=5u){alpha*=clamp((now-life.z)/min(400.0,g.timing.z*0.4),0.0,1.0);if(now>life.y){alpha*=clamp(1.0-(now-life.y)/180.0,0.0,1.0);}}
 if(mode!=0u && life.z > -1e8 && now>life.y){alpha*=clamp(1.0-(now-life.y)/120.0,0.0,1.0);}
 if(g.flags.x>0.0 && life.z > -1e8){if(mode==0u){alpha*=clamp((life.x-now-g.timing.z*0.3)/(g.timing.z*0.3),0.0,1.0);}else if(mode==3u){alpha*=clamp((motion.w-centre.y-motion.w*0.15)/(motion.w*0.25),0.0,1.0);}else{alpha*=clamp((life.x-now)/400.0,0.0,1.0);}}
 if(g.flags.y>0.0 && mode==3u && life.z > -1e8){alpha*=clamp((centre.y-motion.w*0.3)/(motion.w*0.3),0.0,1.0);}
 if(g.flags.z>0.0 && mode==3u && life.z > -1e8){centre.y=384.0-centre.y;}
 if((kind==0u && shape.x==2.0) || shape.x==3.0){angle=motion.y;}
 let local=corners[index]*size;let rotated=vec2f(local.x*cos(angle)-local.y*sin(angle),local.x*sin(angle)+local.y*cos(angle));let point=centre+rotated;
 let scale=min(g.viewport.y/640.0,g.viewport.z/480.0);let screen=(point-vec2f(256.0,192.0))*scale;
 var result:Vertex;result.position=vec4f(screen.x/g.viewport.y*2.0,-screen.y/g.viewport.z*2.0,0.0,1.0);if(alpha<=0.0){result.position=vec4f(2.0,2.0,0.0,1.0);}result.local=corners[index]*2.0;result.colour=vec4f(tint.rgb,alpha);result.uv=uv.xy+(corners[index]+0.5)*uv.zw;result.shape=vec4f(shape.x,size.x/max(0.01,size.y),shape.y,0.0);result.world=point;return result;
}
@fragment fn fs(v:Vertex)->@location(0) vec4f{
 let shape=u32(v.shape.x);let d=length(v.local);var colour=v.colour;var coverage=1.0;let aa=max(fwidth(d),0.005);
 if(u32(g.viewport.w)==3u && (v.world.y<0.0 || v.world.y>384.0)){discard;}
 if(shape==0u){coverage=1.0-smoothstep(1.0-aa,1.0,d);colour=vec4f(colour.rgb*(0.75+0.25*clamp(1.0-v.local.y,0.0,1.0)),colour.a);}
 if(shape==1u){coverage=(1.0-smoothstep(1.0-aa,1.0,d))*smoothstep(0.85-aa,0.85,d);}
 if(shape==2u){let p=vec2f(v.local.x*v.shape.y,v.local.y);let q=p-vec2f(clamp(p.x,-v.shape.y+1.0,v.shape.y-1.0),0.0);coverage=1.0-smoothstep(1.0-aa,1.0,length(q));}
 if(shape==3u){let x=v.local.x;let y=abs(v.local.y);coverage=select(0.0,1.0,x>-0.8 && x<0.8 && y<(0.8-x)*0.6 && y>(0.2-x)*0.6);}
 if(shape==5u){let a=length((v.local-vec2f(-0.2,0.1))/vec2f(0.7,0.8));let b=length((v.local-vec2f(0.2,0.1))/vec2f(0.7,0.8));coverage=1.0-smoothstep(1.0-aa,1.0,min(a,b));}
 if(shape==6u){var nearest=10.0;for(var i=0u;i<6u;i++){let row=select(0.0,0.55,i>2u);let x=f32(i%3u)*0.55-0.55;nearest=min(nearest,length(v.local-vec2f(x,row-0.3))/0.4);}coverage=1.0-smoothstep(1.0-aa,1.0,nearest);}
 if(shape==8u){let outer=length(v.local-vec2f(-0.15,-0.3));let inner=length(v.local-vec2f(0.15,-0.5));coverage=(1.0-smoothstep(1.0-aa,1.0,outer))*smoothstep(0.74-aa,0.74,inner);}
 if(shape==9u){coverage=1.0-smoothstep(1.0-aa,1.0,d);let rim=smoothstep(0.72,0.78,d);colour=vec4f(mix(vec3f(0.86,0.65,0.5),vec3f(0.45,0.48,0.5),rim),colour.a);if(abs(v.local.x)<0.025){colour=vec4f(0.2,0.2,0.2,colour.a);}}
 if(shape==10u){let tex=textureSampleLevel(atlas,atlasSampler,v.uv,0.0);colour=vec4f(tex.rgb*colour.rgb,tex.a*colour.a);}
 if(shape==11u){let spoke=pow(max(0.0,cos(atan2(v.local.y,v.local.x)*6.0)),8.0);coverage=(1.0-smoothstep(1.0-aa,1.0,d))*max(smoothstep(0.83,0.88,d),spoke*smoothstep(0.25,0.35,d));}
 if(g.cursor.z>0.0){coverage*=1.0-smoothstep(90.0,125.0,distance(v.world,g.cursor.xy));}
 let alpha=colour.a*coverage;if(alpha<0.002){discard;}return vec4f(colour.rgb*alpha,alpha);
}
`;
