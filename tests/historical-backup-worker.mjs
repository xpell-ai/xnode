import {_x,bindEntityHistoricalImport,backupEntityHistoricalImport,restoreEntityHistoricalImport,resumeEntityHistoricalImportRestore} from '../dist/index.js';
import {XEntityManager} from '../dist/XEntityManager/XEntityManager.js';
process.once('message',async input=>{
 let owner;
 try {
  await _x.loadModuleAsync(new XEntityManager({_work_folder:input.ordinary}));
  const key=Buffer.from(input.key.data);
  const fault=point=>{if(point===input.point){process.stdout.write('BACKUP_CHECKPOINT '+point+'\n');process.kill(process.pid,'SIGKILL');}};
  if(input.mode==='backup'){
   owner=await bindEntityHistoricalImport(input.importOptions);
   for(const unit of input.units){const r=await owner.commit(unit);if(!r._ok)throw Error('import rejected');}
   process.send({ready:true});await new Promise(resolve=>process.once('message',resolve));
   await backupEntityHistoricalImport({...input.backupOptions,_owner:owner,_key:key,_fault:fault});
  } else {
   const options={...input.restoreOptions,_key:key,...(input.mode==='hold'?{}:{_fault:fault})};
   if(input.mode==='resume'||input.mode==='hold')owner=await resumeEntityHistoricalImportRestore(options);
   else owner=await restoreEntityHistoricalImport(options);
   if(input.mode==='hold') {process.send({ready:true});await new Promise(resolve=>process.once('message',resolve));}
   const r=await owner.reconcile();process.send({verified:r._ok,records:r._result._records,receipts:r._result._receipts,financial_ready:r._result._financial_ready});
  }
  await owner?.close();process.exit(0);
 } catch { await owner?.close();process.send({unavailable:true});process.exit(0); }
});
