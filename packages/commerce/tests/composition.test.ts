import { compositionConformance, memoryHarness } from "./composition-suite";
compositionConformance("composition service (in-memory port)", async () => memoryHarness());
