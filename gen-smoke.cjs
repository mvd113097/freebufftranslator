// Generates buffy-smoke forced-truncation payload: ~40k chars, 100 paragraphs.
// Each paragraph ends with a unique spirit-stone count (101..200) — digits that
// survive translation — enabling mechanical order/completeness verification.
const fs = require("fs");

const NAMES = ["李青云", "苏若雪", "灰袍老者", "柳长老", "青云子", "叶孤城"];
const PLACES = ["后山", "深谷", "藏经阁", "青云峰", "落霞镇", "黑水潭"];
const ITEMS = ["青莲剑", "玉简", "灵石", "丹药", "符箓", "古卷"];

const SENTS = [
  (n, p, it) => `${n}握紧手中的${it}，掌心传来一阵温润的震颤，仿佛有什么东西正在苏醒。`,
  (n, p, it) => `${p}的晨雾还未散尽，${n}已沿着湿滑的石阶缓缓而上，露水打湿了衣角。`,
  (n, p, it) => `远处的松涛声一阵接一阵，${n}停下脚步，仔细分辨着风中是否夹杂着灵气波动。`,
  (n, p, it) => `师父的叮嘱忽然在耳边响起：修行之人最忌心浮气躁，越是紧要关头，越要沉得住气。`,
  (n, p, it) => `${it}表面的纹路微微发亮，像是回应着主人心境的变化，随即又归于沉寂。`,
  (n, p, it) => `一道灰影从林间掠过，快得几乎看不清轮廓，只在落叶上留下浅浅的足迹。`,
  (n, p, it) => `${n}想起白日里那位老者说过的话，心中泛起层层涟漪，久久无法平静。`,
  (n, p, it) => `潭水深处隐约有金光流转，可惜隔着重重雾气，任谁也看不真切。`,
  (n, p, it) => `他盘膝坐下，闭目内视，只觉丹田处那缕真气比昨日壮大了几分。`,
  (n, p, it) => `夜色渐深，山间的兽鸣此起彼伏，${n}却充耳不闻，一心沉浸 in 吐纳之中。`.replace(" in ", ""),
  (n, p, it) => `忽然，一声清越的剑鸣自谷底传来，惊起满林飞鸟。`,
  (n, p, it) => `${p}的石壁上刻着前人留下的剑痕，一笔一划都蕴着说不出的韵味。`,
  (n, p, it) => `若能参透其中奥妙，这一身的修为必将百尺竿头更进一步。`,
  (n, p, it) => `${n}不敢怠慢，将${it}小心收好，警惕地环顾四周。`,
  (n, p, it) => `风停了，雾也散了，天地间仿佛只剩下他一人一剑。`,
  (n, p, it) => `他知道，从踏进这片山谷的那一刻起，命运之轮便已开始转动。`,
  (n, p, it) => `远处传来零星的犬吠，那是山脚下的村落仍未入睡的人家。`,
  (n, p, it) => `月光洒在青石小径上，映出两道一长一短的影子。`,
  (n, p, it) => `${n}深吸一口气，将纷乱的思绪尽数压下，重新握紧了手中的${it}。`,
  (n, p, it) => `前方的路还很长，而每一步，都可能踏在生死边缘。`,
];

function paragraph(i) {
  const n = NAMES[i % NAMES.length];
  const p = PLACES[(i * 3 + 1) % PLACES.length];
  const it = ITEMS[(i * 5 + 2) % ITEMS.length];
  let body = "";
  let k = 0;
  while (body.length < 380) {
    const s = SENTS[(i * 2 + k * 7) % SENTS.length](n, p, it);
    if (!body.includes(s)) body += s;
    k++;
    if (k > 30) break;
  }
  const N = 100 + i;
  return `${body}临行前，他又清点了一遍储物袋，里面正好有${N}枚中品灵石，这是他此行仅有的积蓄。`;
}

const paragraphs = [];
for (let i = 1; i <= 100; i++) paragraphs.push(`〔${i}〕` + paragraph(i));
const text = paragraphs.join("\n\n");

// Sanity: Arabic digits allowed are paragraph tags 1..100 (in 〔〕) and
// spirit-stone counts 101..200. Anything else fails the build.
const stray = text.match(/\d+/g).filter((d) => {
  const v = parseInt(d, 10);
  return !(v >= 1 && v <= 200);
});
if (stray.length) {
  console.error("STRAY DIGITS:", stray);
  process.exit(1);
}

const payload = {
  fileName: `buffy-smoke-truncation-40k-${Date.now()}.txt`,
  model: "inclusionai/ling-3.0-flash-fin:free",
  keys: [
    "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",
    "AQ.Ab8RN6JLFeMyjFMJEpj_22GQ2BffWgnGIAZn2U44-FtrQgEgAQ",
  ],
  smoke: { forceMaxOutputTokens: 4096 },
  chunks: [
    {
      text,
      gzip: false,
      originalId: 0,
      partIndex: 0,
      partCount: 1,
    },
  ],
  liveModels: [
    "inclusionai/ling-3.0-flash-fin:free",
    "inclusionai/ling-3.0-flash-sante:free",
    "google/gemma-4-31b-it:free",
    "nex-agi/nex-n2.5-pro:free",
    "nvidia/nemotron-3.5-lightning:free",
  ],
  originalChunkCount: 1,
};

fs.writeFileSync("smoke-job.tmp.json", JSON.stringify(payload));
console.log("chars:", text.length);
console.log("paragraphs:", paragraphs.length);
console.log("file:", payload.fileName);
