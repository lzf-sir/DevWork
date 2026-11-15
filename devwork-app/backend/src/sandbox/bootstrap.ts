/**
 * 沙箱引导（仅启动时执行，不暴露 API）。
 * 写真实代码文件 + 敏感文件 + git 仓库 + 真实产物占位文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ARTIFACTS_DIR, REPOS_DIR, ensureDirs } from '../config';
import { DOC_FILES } from './docs';

export const REPO_ROOT = path.join(REPOS_DIR, 'order-service');

const INVENTORY_CLIENT = `package com.example.order;

import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;
import org.springframework.http.client.HttpComponentsClientHttpRequestFactory;

@Component
public class InventoryClient {

  // HACK: RestTemplate 在这里当单例用，并发下要先确认线程安全性
  private final RestTemplate restTemplate = new RestTemplate();
  private final String url = "http://inventory-service/api/stock";

  public InventoryResp deduct(String sku, int qty) {
    HttpComponentsClientHttpRequestFactory f =
        new HttpComponentsClientHttpRequestFactory();
    f.setConnectTimeout(800);
    // TODO: 超时目前写死在这里，应该走配置中心
    f.setReadTimeout(2000);
    restTemplate.setRequestFactory(f);
    return restTemplate.postForObject(url, req, InventoryResp.class);
  }

  public InventoryResp queryStock(String sku) {
    return restTemplate.getForObject(url + "/" + sku, InventoryResp.class);
  }
}
`;

const ORDER_SERVICE = `// TODO: 这个包还没有统一异常映射，repository 的异常会直接冒到 controller
package com.example.order;

import org.springframework.stereotype.Service;

@Service
public class OrderService {

  private final OrderRepository repository;

  public OrderService(OrderRepository repository) {
    this.repository = repository;
  }

  public Order findById(long id) {
    return repository.findById(id).orElseThrow();
  }
}
`;

const ORDER_CONTROLLER = `package com.example.order;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/orders")
public class OrderController {

  private final OrderService service;

  public OrderController(OrderService service) {
    this.service = service;
  }

  // FIXME: 这个接口没有分页，订单量上来会拖垮数据库
  @GetMapping("/{id}")
  public Order get(@PathVariable long id) {
    return service.findById(id);
  }
}
`;

const ORDER_REPOSITORY = `package com.example.order;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;

public interface OrderRepository
    extends JpaRepository<Order, Long> {

  List<Order> findByStatus(String status);
}
`;

const POM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>order-service</artifactId>
  <version>1.8.2</version>
  <properties><java.version>17</java.version></properties>
</project>
`;

const APPLICATION_YML = `server:
  port: 8080
spring:
  datasource:
    url: jdbc:postgresql://127.0.0.1:5432/order_db
    username: readonly
inventory:
  connect-timeout-ms: 800
  read-timeout-ms: 2000
`;

const TEST_FILE = `package com.example.order;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertNotNull;

class InventoryClientTest {
  @Test
  void deductReturnsResponse() {
    assertNotNull(new InventoryClient());
  }
}
`;

/** 敏感文件：用于验证 FileService 的 12 条排除规则（文件树中不可见）。 */
const SENSITIVE_FILES: [string, string][] = [
  ['.env', 'DB_PASSWORD=local-demo-only\nOPENAI_API_KEY=not-a-real-key\n'],
  ['id_rsa', '-----BEGIN DEMO PRIVATE KEY-----\nlocal sandbox only\n-----END DEMO PRIVATE KEY-----\n'],
  ['server.pem', '-----BEGIN CERTIFICATE-----\nlocal sandbox only\n-----END CERTIFICATE-----\n'],
  ['secrets/credentials.json', '{"user":"demo"}\n'],
];

function writeIfMissing(absolute: string, content: string): void {
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  if (!fs.existsSync(absolute)) fs.writeFileSync(absolute, content, 'utf8');
}

function git(args: string[]): void {
  try {
    execFileSync('git', args, { cwd: REPO_ROOT, stdio: 'ignore', timeout: 10000 });
  } catch {
    /* git 不可用时降级为纯文件系统沙箱，不阻塞启动 */
  }
}

/** 幂等创建代码仓库与 git 历史。 */
export function bootstrapRepo(): void {
  ensureDirs();
  const files: [string, string][] = [
    ['src/main/java/order/InventoryClient.java', INVENTORY_CLIENT],
    ['src/main/java/order/OrderService.java', ORDER_SERVICE],
    ['src/main/java/order/OrderController.java', ORDER_CONTROLLER],
    ['src/main/java/order/OrderRepository.java', ORDER_REPOSITORY],
    ['src/main/resources/application.yml', APPLICATION_YML],
    ['src/test/java/order/InventoryClientTest.java', TEST_FILE],
    ['pom.xml', POM_XML],
    ['README.md', '# order-service\n\nDevWork 本地沙箱演示仓库，非项目文档。\n'],
  ];
  files.forEach(([rel, content]) => writeIfMissing(path.join(REPO_ROOT, rel), content));
  SENSITIVE_FILES.forEach(([rel, content]) => writeIfMissing(path.join(REPO_ROOT, rel), content));
  /* 运营知识库的真实文档：引用能点回原文的前提是源文件在磁盘上存在。
   * 放在仓库 docs/ 下，既能被文件树看到，也能被知识库索引当 doc 块检索。 */
  DOC_FILES.forEach(([rel, content]) => writeIfMissing(path.join(REPO_ROOT, rel), content));

  if (!fs.existsSync(path.join(REPO_ROOT, '.git'))) {
    git(['init', '-q']);
    git(['config', 'user.email', 'devwork@localhost']);
    git(['config', 'user.name', 'DevWork']);
    git(['add', '.']);
    git(['commit', '-q', '-m', 'chore: seed order-service sandbox repo']);
  }
}

/** 生成真实占位文件，downloadArtifact / 产物角标返回真实 size。 */
export function bootstrapArtifacts(): void {
  ensureDirs();
  const doc = path.join(ARTIFACTS_DIR, '季度复盘.docx');
  const png = path.join(ARTIFACTS_DIR, 'gmv_trend.png');
  if (!fs.existsSync(doc)) fs.writeFileSync(doc, Buffer.alloc(88064, 0x20));
  if (!fs.existsSync(png)) {
    const header = Buffer.from('89504e470d0a1a0a', 'hex');
    fs.writeFileSync(png, Buffer.concat([header, Buffer.alloc(131072 - header.length, 0x20)]));
  }
}

export function artifactPath(name: string): string {
  return path.join(ARTIFACTS_DIR, path.basename(name));
}

export function artifactSize(name: string): number {
  try {
    return fs.statSync(artifactPath(name)).size;
  } catch {
    return 0;
  }
}
