/**
 * 真实 Lottie 素材挂载点（可选）
 * ------------------------------------------------------------
 * 默认情况下，预设宠物（cat/dog/rabbit/dino/otter）的动画由
 * src/utils/lottiePet.js 在运行时生成，无需任何外部文件。
 *
 * 如果你以后拿到美术给的 Lottie 文件（.json），想替换掉生成版：
 *   1) 把文件放到 src/assets/lottie/cat.json 等位置
 *   2) 在此处 import 并登记，例如：
 *
 *      import cat from "../assets/lottie/cat.json";
 *      export default { cat };
 *
 * 登记后 PetMotion / LottiePet 会自动优先使用它，不用改其它代码。
 */
export default {};