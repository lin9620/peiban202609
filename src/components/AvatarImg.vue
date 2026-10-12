import { defineComponent, h } from "vue";
import { avatarUrlFor } from "../utils/avatar.js";

const AVATAR_SIZES = [96, 192, 384];   /* CSS 上限 96px，@2x/4x 三档，srcset 自动选 */

/**
 * 头像统一出口（轮 239 性能）：懒加载 + 像素密度自适应 srcset + 哨兵自愈。
 * 所有 uid 头像走 <AvatarImg :uid="…" :size="…" :name="…" />，别再手写 <img>。
 * - lazy：列表里的头像不抢首屏带宽/解码
 * - srcset：高分屏按需取 192/384，省 4 倍字节
 * - 失败/无 uid：落回首字母圆（name 首字）
 */
export const AvatarImg = defineComponent({
  name: "AvatarImg",
  props: {
    uid: { type: String, default: "" },
    size: { type: Number, default: 40 },
    name: { type: String, default: "" },
    alt: { type: String, default: "" },
  },
  setup(props) {
    return () => {
      const url = props.uid ? avatarUrlFor(props.uid, 384) : "";
      const srcset = url ? AVATAR_SIZES.map((s) => `${avatarUrlFor(props.uid, s)} ${s}w`).join(", ") : "";
      return url
        ? h("img", {
            class: "avatar-img",
            src: url,
            srcset: srcset || undefined,
            sizes: `${props.size}px`,
            loading: "lazy",
            decoding: "async",
            alt: props.alt || props.name || "",
            style: { width: props.size + "px", height: props.size + "px" },
          })
        : h(
            "span",
            {
              class: "avatar-fallback",
              style: {
                width: props.size + "px",
                height: props.size + "px",
                fontSize: Math.round(props.size * 0.42) + "px",
              },
            },
            (props.name || "?").slice(0, 1).toUpperCase()
          );
    };
  },
});
