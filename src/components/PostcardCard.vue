<script setup>
import { computed } from "vue";
import { i18n } from "../i18n.js";
import { destByKey } from "../data/adventure.js";

const props = defineProps({
  card: { type: Object, required: true }, // { destKey, ts }
  petEmoji: { type: String, default: "\u{1F431}" },
  petName: { type: String, default: "" },
});

const dest = computed(() => destByKey(props.card.destKey));
const when = computed(() =>
  new Date(props.card.ts).toLocaleDateString(i18n.locale === "zh" ? "zh-CN" : "en-US",
    { month: "short", day: "numeric" })
);
const gid = computed(() => "sky-" + props.card.destKey + "-" + props.card.ts);
</script>

<template>
  <div class="postcard">
    <svg viewBox="0 0 320 210" class="pc-scene">
      <defs>
        <linearGradient :id="gid" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" :stop-color="dest.sky[0]" />
          <stop offset="1" :stop-color="dest.sky[1]" />
        </linearGradient>
      </defs>
      <rect width="320" height="150" :fill="`url(#${gid})`" />
      <circle cx="264" cy="42" r="20" fill="#ffd98a" opacity=".9" />
      <ellipse cx="80" cy="46" rx="34" ry="12" fill="#fff" opacity=".85" />
      <ellipse cx="112" cy="54" rx="24" ry="9" fill="#fff" opacity=".7" />
      <ellipse cx="210" cy="70" rx="28" ry="10" fill="#fff" opacity=".6" />
      <text x="58" y="86" font-size="46">{{ dest.ico }}</text>
      <rect y="146" width="320" height="64" :fill="dest.ground" />
      <rect y="146" width="320" height="8" fill="#fff" opacity=".28" />
      <ellipse :cx="236" cy="196" rx="34" ry="6" fill="rgba(70,45,20,.22)" />
      <text x="212" y="196" font-size="34">{{ petEmoji }}</text>
      <g class="pc-stamp">
        <rect x="270" y="12" width="38" height="44" rx="5" fill="#fffdf5" stroke="#d9a86c" stroke-width="1.5" />
        <text x="279" y="44" font-size="22">🍀</text>
      </g>
    </svg>
    <div class="pc-caption">
      <b>{{ dest.name[i18n.locale] || dest.name.en }}</b>
      <span>{{ when }}</span>
    </div>
  </div>
</template>

<style scoped>
.postcard {
  background: #fffdf8;
  border-radius: 14px;
  padding: 8px 8px 10px;
  box-shadow: 0 6px 18px rgba(160, 110, 60, .16);
  border: 1px solid rgba(255, 255, 255, .8);
  transition: transform .25s ease, box-shadow .25s ease;
}
.postcard:hover { transform: translateY(-4px) rotate(-1deg); box-shadow: 0 14px 28px rgba(160, 110, 60, .22); }
.pc-scene { width: 100%; border-radius: 9px; display: block; }
.pc-stamp { transform: rotate(6deg); }
.pc-caption { display: flex; justify-content: space-between; align-items: baseline; padding: 7px 3px 0; }
.pc-caption b { font-size: 12.5px; color: var(--ink); }
.pc-caption span { font-size: 11px; color: var(--ink-soft); }
</style>