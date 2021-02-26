import cloneDeep from 'lodash.clonedeep';
import Upload from '@app/helpers/upload';
import download from '@app/helpers/download';
import { fse, join } from '@all-in-js/utils';
import { createExcel, parseExcel } from '@app/helpers/xlsx';
import uid from 'unique-string';

function createTempFile(cx, fileType) {
  const { cacheFolder } = cx.config;
  const filepath = join(cacheFolder, `${uid()}.${fileType}`);
  const ws = fse.createWriteStream(filepath);
  return new Promise((rs, rj) => {
    ws.on('finish', () => {
      rs(filepath);
    });
    ws.on('error', e => {
      rj(e);
    });
    cx.req.pipe(ws);
  });
}
// 基于proj的上传
// todo：基于全局的上传
export async function uploadExcel(cx) {
  const { lang, byName } = cx.query;
  let { fileType, proj_id } = cx.query;
  const { dir } = cx.config.upload;
  let tempFilePath;

  if (!lang) {
    return cx.failed(400, `the 'lang' params excepted.`);
  }

  if (!['json', 'xlsx'].includes(fileType)) {
    return cx.failed(400, 'json or xlsx file excepted.');
  }

  if (!byName && !proj_id) {
    return cx.failed(400, 'proj_id excepted.');
  }

  if (byName) {
    const proj = await findProjByName.call(cx, byName);
    if (!proj) {
      return cx.failed(400, `project does not exists, please run 'i18n push'.`);
    }
    proj_id = proj.id;
    // 客户端上传必须带上项目名称
    try {
      tempFilePath = await createTempFile(cx, fileType);
    } catch (e) {
      return cx.failed(500, e.message);
    } 
  } else {
    const form = new Upload({
      key: 'file',
      uploadDir: dir,
      keepExtensions: true
    });
    const { files } = await form.transform(cx.req);
    tempFilePath = files.path;
  }

  const getData = () => {
    if (fileType === 'xlsx') {
      const [data] = parseExcel(tempFilePath);
      return data.data.slice(1); // 去掉第一行的title
    }
    if (fileType === 'json') {
      const json = require(tempFilePath);
      return Object.keys(json).map(key => {
        return [key, json[key]];
      });
    }
  }
  
  const updatedMess = [];
  const insertMess = [];

  let untranslated = await cx.models.Message.findAll({
    where: {
      lang,
      // translated: false,
      from_proj: proj_id
    }
  });
  untranslated = untranslated.reduce((untransMess, item) => {
    untransMess[item.key] = item;
    return untransMess;
  }, {});

  for (const [key, value] of getData()) {
    const untransItem = untranslated[key];
    if (untransItem) {
      if (untransItem.value !== value) {
        untransItem.value = value;
        untransItem.translated = true;
        updatedMess.push(untransItem);
      }
    } else {
      insertMess.push({
        lang,
        key,
        value,
        from_proj: proj_id,
        editor: [],
        translated: true
      });
    }
  }
  if (updatedMess.length) {
    const updates = updatedMess.map(item => {
      return cx.models.Message.update({
        value: item.value,
        translated: true
      }, {
        where: {
          id: item.id
        }
      });
    });
    await Promise.all(updates);
  }
  if (insertMess.length) {
    await cx.models.Message.bulkCreate(insertMess);
  }

  fse.unlink(tempFilePath, e => { });
  cx.success('ok');
}

export async function getUntranslatedMessages(cx) {
  const { lang = 'en-US', name } = cx.request.body;
  if (!name) {
    return cx.failed(400, 'project name excepted.');
  }
  const proj = await findProjByName.call(cx, name);
  if (!proj) {
    return cx.failed(500, `project does not exists, please run 'i18n push'.`);
  }

  const projUntransMess = await cx.models.Message.findAll({
    where: {
      from_proj: proj.id,
      translated: false,
      lang: lang.split(',')
    }
  });

  cx.success(projUntransMess);
}

/**
 * 导出未翻译词条
 * lang 语言类型
 * proj_id 项目id
 * fileType 文件类型
 */
function filename(name, lang) {
  return `待翻译词条.${name}.${lang}`;
}

function exportExcel(cx, lang, proj, untransMess) {
  const data = untransMess.reduce((newData, item) => {
    newData.push([item.key]);
    return newData;
  }, []);
  const filepath = `${filename(proj.name, lang)}.xlsx`;
  createExcel(proj.name, filepath, data);
  download(cx, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filepath);
}

function exportJson(cx, lang, proj, untransMess) {
  const json = untransMess.reduce((obj, item) => {
    return Object.assign(obj, {
      [item.key]: item.value
    });
  }, {});
  const filepath = `${filename(proj.name, lang)}.json`;
  fse.writeJsonSync(filepath, json, {
    spaces: 2
  });
  download(cx, 'application/json', filepath);
}
export async function exportUntransItems(cx) {
  const { proj_id, lang = 'zh-CN', fileType = 'xlsx'} = cx.query;
  if (!proj_id) {
    return cx.failed(400, 'proj_id excepted.');
  }
  const untransMess = await cx.models.Message.findAll({
    where: {
      lang,
      translated: false,
      from_proj: proj_id
    }
  });
  if (untransMess.length) {
    const proj = (await cx.models.Proj.findOne({
      where: {
        id: proj_id
      }
    }));

    if (fileType === 'json') {
      exportJson(cx, lang, proj, untransMess);
    } else {
      exportExcel(cx, lang, proj, untransMess);
    }
    
    fse.unlinkSync(filepath);
  } else {
    cx.failed('没有可导出数据.');
  }
}

/**
 * 获取项目列表
 */
export async function getProjList(cx) {
  const projs = await cx.models.Proj.findAll();
  cx.success(projs);
}

/**
 * 删除项目
 */
export async function removeProj(cx) {
  const { proj_id } = cx.request.body;
  if (!proj_id) {
    return cx.failed(400, 'proj_id excepted.');
  }
  await cx.models.Proj.destroy({
    where: {
      id: proj_id
    }
  });
  await cx.models.Message.destroy({
    where: {
      from_proj: proj_id
    }
  });
  cx.success('ok');
}

/**
 * 编辑词条 
 */
export async function editMessage(cx) {
  const { id, value } = cx.request.body;
  if (!id || !value) {
    return cx.failed(400, 'id or value excepted.');
  }
  await cx.models.Message.update({
      value
    }, {
      where: {
        id
      }
    });
  cx.success('ok');
}

/**
 * 删除词条
 */
export async function removeMessage(cx) {
  const { ids } = cx.request.body;
  if (!ids) {
    return cx.failed(400, 'ids excepted.');
  }
  await cx.models.Message.destroy({
    where: {
      id: ids.split(',')
    }
  });
  cx.success('ok');
}

/**
 * 清空项目下的词条
 */
export async function clearProjMessages(cx) {
  const { proj_id } = cx.request.body;
  if (!proj_id) {
    return cx.failed(400, 'proj_id excepted.');
  }
  await cx.models.Message.destroy({
    where: {
      from_proj: proj_id
    }
  });
  cx.success('ok');
}

/**
 * 获取某个项目的词条
 * query: lang
 * params: id
 */
export async function getProjMessagesList(cx) {
  const { lang = 'zh-CN', proj_id } = cx.query;
  const query = {
    where: {
      lang
    }
  }
  if (proj_id) {
    query.where.from_proj = proj_id;
  }
  const projMess = await cx.models.Message.findAll(query);
  cx.success(projMess);
}

/**
 * 通过名称查找项目
 */
async function findProjByName(name) {
  const proj = await this.models.Proj.findOne({
    where: {
      name
    }
  });
  return proj;
}

export async function findProjLangMessages(cx) {
  const { name, lang = '' } = cx.request.body;
  if (!name) {
    return cx.failed(400, 'the project name excepted.');
  }

  const proj = await findProjByName.call(cx, name);
  const query = {
    from_proj: proj.id
  }
  if (lang) {
    query.lang = lang.split(',');
  }
  const mess = await cx.models.Message.findAll({
    where: query
  });
  cx.success(mess);
}

/**
 * 更新维护者
 */
async function updateMaintainer(name, maintainer) {
  let proj = await findProjByName.call(this, name);
  if (proj) {
    if (proj.maintainer !== maintainer) {
      await this.models.Proj.update({
        maintainer
      }, {
        where: {
          name
        }
      });
    }
  } else {
    await this.models.Proj.create({
      name,
      maintainer
    });
  }
}

// messages: {
//   [path]: {
//     [lang]: {
//       k: v
//     }
//   }
// }

/**
 * 更新词条
 */
async function updateMessages(proj_id, lang, processedMessages) {
  const projMessages = await this.models.Message.findAll({
    where: {
      lang,
      from_proj: proj_id
    }
  });

  const willUpdateMess = [];
  const willInsertMess = [];
  for (const key in processedMessages[lang].messages) {
    const oriMess = projMessages.filter(item => item.key === key)[0];
    const newVal = processedMessages[lang].messages[key];

    if (oriMess) {
      if (newVal !== oriMess.value || !oriMess.translated) {
        willUpdateMess.push({
          ...oriMess.dataValues,
          ...{
            value: newVal,
            translated: true
          }
        });
      }
    } else {
      willInsertMess.push({
        lang,
        key,
        value: processedMessages[lang].messages[key],
        translated: true,
        from_proj: proj_id,
        editor: []
      });
    }
  }
  for (const key in processedMessages[lang].untranslated) {
    const oriMess = projMessages.filter(item => item.key === key)[0];
    const newVal = processedMessages[lang].untranslated[key];

    if (oriMess) {
      if (newVal !== oriMess.value || oriMess.translated) {
        willUpdateMess.push({
          ...oriMess.dataValues,
          ...{
            value: processedMessages[lang].untranslated[key],
            translated: false
          }
        });
      }
    } else {
      willInsertMess.push({
        lang,
        key,
        value: processedMessages[lang].untranslated[key],
        translated: false,
        from_proj: proj_id,
        editor: []
      });
    }
  }
  if (willUpdateMess.length) {
    const updates = willUpdateMess.map(item => {
      return this.models.Message.update({
              value: item.value
            }, {
              where: {
                id: item.id
              }
            });
    });
    await Promise.all(updates);
  }
  if (willInsertMess.length) {
    await this.models.Message.bulkCreate(willInsertMess);
  }
}

async function combineLangMessages(proj_id, messages) {
  const langMessages = Object.values(messages).reduce((langMessages, item) => {
    let parsed = {};
    try {
      parsed = item;
    } catch (e) {
      console.log(e);
    }
    for (const lang in parsed) {
      const mess = langMessages[lang] || {};
      langMessages[lang] = { ...mess, ...parsed[lang] };
    }
    return langMessages;
  }, {});

  const processedMessages = {};
  for (const lang in langMessages) {
    const mess = langMessages[lang];
    const allMess = await this.models.Message.findAll({
      where: {
        lang
      }
    });
    processedMessages[lang] = {
      messages: mess,
      untranslated: {}
    }

    if (lang !== 'zh-CN') {
      const zhCN = langMessages['zh-CN'];
      for (const item in mess) {
        const untrans = mess[item];
        if (untrans === zhCN[item]) {
          const matchItem = allMess.find(langMess => {
            return langMess.lang === lang &&
              langMess.key === item &&
              langMess.translated
          });
          if (matchItem) {
            // 总库比对
            mess[item] = matchItem.value;
          } else {
            processedMessages[lang].untranslated[item] = untrans;
            delete mess[item];
          }
        } else {

        }
      }
    }

    await updateMessages.call(this, proj_id, lang, processedMessages);
  }
}

async function getNewMessages(proj_id, messages = {}) {
  const newMess = cloneDeep(messages);
  const pathes = Object.keys(newMess);
  if (pathes.length) {
    for (const p of pathes) {
      const langMess = newMess[p];
      const langs = Object.keys(langMess);
      for (const lang of langs) {
        const newLangMess = await this.models.Message.findAll({
          where: {
            lang,
            from_proj: proj_id
          }
        });
        const fmtedMess = formatNewmess(newLangMess);
        const zhCN = langMess['zh-CN'];

        if (zhCN) {
          for (const item in zhCN) {
            if (!langMess[lang][item]) {
              langMess[lang][item] = zhCN[item]; // 同步zh-CN
            }
          }
          for (const item in langMess[lang]) {
            if (!zhCN[item]) {
              delete langMess[lang][item];
            } else {
              langMess[lang][item] = fmtedMess[item];
            }
          }
        }
      }
    }
  }
  return newMess;
}

function formatNewmess(newMess = []) {
  return newMess.reduce((mess, item) => {
    mess[item.key] = item.value;
    return mess;
  }, {});
}

export async function syncMessages(cx) {
  const { name, maintainer = 'unknown', messages } = cx.request.body;
  if (!name) {
    return cx.failed(400, 'a project name excepted.');
  }

  await updateMaintainer.call(cx, name, maintainer);

  const proj = await findProjByName.call(cx, name);
  const proj_id = proj.id;

  await combineLangMessages.call(cx, proj_id, messages);

  const newMess = await getNewMessages.call(cx, proj_id, messages);

  cx.success(newMess);

}