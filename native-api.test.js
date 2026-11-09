import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeApi,STORAGE_KEY} from './native-api.js';
function fixture(){
  const requests=[],c={chatId:'one',getCurrentChatId:()=>c.chatId,characterId:1,groupId:null,name1:'User',mainApi:'openai',chat:[],chatMetadata:{other:5},extensionSettings:{},saveMetadata:async()=>{c.saved=true;},saveSettingsDebounced:async()=>{},getChatCompletionModel:()=> 'test-model',chatCompletionSettings:{openai_max_tokens:300},eventTypes:{CHAT_CHANGED:'changed'},eventSource:{on(){},removeListener(){}}};
  c.ChatCompletionService={presetToGeneratePayload:async(_a,_b,p)=>{requests.push(p);return p;},sendRequest:async()=>async function*(){yield {text:'{"entries":'};yield {text:'{"entries":[]}',state:{reasoning:'not stored'}};}};
  const host={SillyTavern:{getContext:()=>c},document:{getElementById:()=>null},addEventListener(){}};
  return {c,api:createNativeApi(host),requests};
}
test('完整读取1000条而非显示页',()=>{const x=fixture();x.c.chat=Array.from({length:1000},(_,i)=>({mes:String(i),is_user:i%2===0}));assert.equal(x.api.messages().length,1000);});
test('当前选中的回复页被读取',()=>{const x=fixture();x.c.chat=[{mes:'旧',swipes:['旧','新'],swipe_id:1}];assert.equal(x.api.messages()[0].message,'新');});
test('没有正文时明确报错',()=>{const x=fixture();x.c.chat=[{}];assert.throws(()=>x.api.messages(),/正文格式/);});
test('保存到当前聊天且不覆盖其他元数据',async()=>{const x=fixture();await x.api.writeStore('',{version:3},x.api.chatId());assert.equal(x.c.chatMetadata.other,5);assert.equal(x.c.chatMetadata[STORAGE_KEY].version,3);assert.ok(x.c.saved);});
test('聊天切换拒绝旧结果写入',async()=>{const x=fixture(),id=x.api.chatId();x.c.chatId='two';await assert.rejects(x.api.writeStore('',{},id),/切换/);});
test('流式响应完成后再返回完整正文',async()=>{const x=fixture();const response=await x.api.analyze('只记录用户');assert.equal(response,'{"entries":[]}');assert.equal(x.requests[0].messages.length,2);});
test('独立响应上限不改用户续写设置',async()=>{const x=fixture();await x.api.analyze('记录');assert.equal(x.requests[0].max_tokens,8192);assert.equal(x.requests[0].stream,true);assert.equal(x.c.chatCompletionSettings.openai_max_tokens,300);});
test('只取消本记录器的请求',async()=>{const x=fixture();let signal;x.c.ChatCompletionService.sendRequest=async(_data,_extract,s)=>{signal=s;return async function*(){yield {text:'{}'};x.api.abortAnalysis();yield {text:'{}'};};};await assert.rejects(x.api.analyze('记录'),/取消|Abort/);assert.equal(signal.aborted,true);});
test('模型空正文不会返回成功',async()=>{const x=fixture();x.c.ChatCompletionService.sendRequest=async()=>({content:''});await assert.rejects(x.api.analyze('记录'),/空正文/);});
test('用户别名不包含NPC角色名',()=>{const x=fixture();x.c.chat=[{is_user:true,name:'陈默',mes:'我'},{is_user:false,name:'苏晓晓',mes:'她'}];assert.deepEqual(x.api.userAliases(),['User','陈默']);});
test('原生接口不可用给出版本说明',async()=>{const x=fixture();delete x.c.ChatCompletionService;await assert.rejects(x.api.analyze('记录'),/1.19/);});
test('非聊天补全连接说明所需API类型',async()=>{const x=fixture();x.c.mainApi='textgenerationwebui';await assert.rejects(x.api.analyze('记录'),/聊天补全/);});
