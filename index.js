import * as Engine from './state-engine.js';
import {createNativeApi} from './native-api.js';
import {startDashboard} from './panel.js';

async function initialize(){
  try{await startDashboard(createNativeApi(window),Engine,'');}
  catch(error){console.error('[用户状态记录] 初始化失败',error);window.toastr?.error(error.message,'用户状态记录');}
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initialize,{once:true});else initialize();
