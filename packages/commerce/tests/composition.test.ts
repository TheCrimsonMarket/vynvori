import { compositionConformance, memoryHarness } from "./composition-suite";
import { storeConformance } from "./composition-store-suite";
compositionConformance("composition service (in-memory port)", async () => memoryHarness());
storeConformance("composition store primitives (in-memory port)", async () => memoryHarness());
