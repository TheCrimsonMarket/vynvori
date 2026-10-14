import {api} from './service';
(globalThis as unknown as {VynvoriMock:typeof api}).VynvoriMock=api;
