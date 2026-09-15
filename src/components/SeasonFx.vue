<script setup>
import { computed } from "vue";
import { seasonNow } from "../data/extras.js";

const props = defineProps({ count: { type: Number, default: 10 } });
const season = seasonNow();

const items = computed(() => {
  const arr = [];
  for (let i = 0; i < props.count; i++) {
    arr.push({
      ico: season.particles[i % season.particles.length],
      left: (i * 97) % 100,
      delay: (i % 5) * 1.7,
      dur: 7 + (i % 4) * 2.3,
      size: 12 + (i % 3) * 6,
    });
  }
  return arr;
});
</script>

<template>
  <div class="season-fx" aria-hidden="true">
    <span
      v-for="(p, i) in items" :key="i" class="sf-p"
      :style="{ left: p.left + '%', animationDelay: p.delay + 's', animationDuration: p.dur + 's', fontSize: p.size + 'px' }">{{ p.ico }}</span>
  </div>
</template>

<style scoped>
.season-fx { position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: 3; }
.sf-p { position: absolute; top: -12%; animation: sfFall linear infinite; opacity: .8; }
@keyframes sfFall {
  0% { transform: translateY(0) rotate(0deg); }
  100% { transform: translateY(560%) rotate(300deg); }
}
</style>