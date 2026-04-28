// ─── RepoCiv — Renderer 3D (WebGL / Three.js) ──────────────────────────────────
import * as THREE from 'three';
import { type Axial, axialToPixel } from './hex.ts';
import { type Tile, type World, type Unit, type City, tileKey } from './types.ts';
import { GameState } from './game.ts';

const HEX_SIZE = 52;
const HEX_HEIGHT = 8;
const SCALE_3D = 0.5; // Scale from pixel to 3D units

export class Renderer3D {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private state: GameState;

  private hexGroup = new THREE.Group();
  private decorGroup = new THREE.Group();
  private unitGroup = new THREE.Group();
  private cityGroup = new THREE.Group();

  private textures: Record<string, THREE.Texture> = {};
  private spriteMaterials: Record<string, THREE.SpriteMaterial> = {};
  private assetsLoaded = false;

  private isRunning = false;
  private camTarget = new THREE.Vector3(0, 0, 0);
  private zoom = 1;

  constructor(container: HTMLElement, state: GameState) {
    this.container = container;
    this.state = state;

    // Renderer setup
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(this.renderer.domElement);

    // Scene & Camera
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x050505);
    
    this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 10000);
    this.camera.position.set(0, 800, 800);
    this.camera.lookAt(0, 0, 0);

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, 0.4);
    this.scene.add(ambient);

    const sun = new THREE.DirectionalLight(0xfff5e0, 1.2);
    sun.position.set(500, 1000, 500);
    sun.castShadow = true;
    sun.shadow.mapSize.width = 2048;
    sun.shadow.mapSize.height = 2048;
    sun.shadow.camera.left = -2000;
    sun.shadow.camera.right = 2000;
    sun.shadow.camera.top = 2000;
    sun.shadow.camera.bottom = -2000;
    this.scene.add(sun);

    // Groups
    this.scene.add(this.hexGroup);
    this.scene.add(this.decorGroup);
    this.scene.add(this.unitGroup);
    this.scene.add(this.cityGroup);

    window.addEventListener('resize', () => this.resize());
  }

  private resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  async loadAssets() {
    const loader = new THREE.TextureLoader();
    const assets = [
      { name: 'plains', url: '/assets/terrain_plains.png' },
      { name: 'forest', url: '/assets/terrain_forest.png' },
      { name: 'desert', url: '/assets/terrain_desert.png' },
      { name: 'ocean', url: '/assets/terrain_ocean.png' },
      { name: 'mountain', url: '/assets/terrain_mountain.png' },
      { name: 'ice', url: '/assets/terrain_ice.png' },
      { name: 'fog', url: '/assets/fog_parchment.png' },
      { name: 'hill_sprite', url: '/assets/hill_sprite.png' },
      { name: 'mountain_sprite', url: '/assets/mountain_sprite.png' },
      { name: 'forest_sprite', url: '/assets/forest_sprite.png' },
    ];

    const promises = assets.map(asset => {
      return new Promise<void>((resolve) => {
        loader.load(asset.url, (texture) => {
          texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
          this.textures[asset.name] = texture;
          if (asset.name.includes('sprite')) {
             this.spriteMaterials[asset.name] = new THREE.SpriteMaterial({ map: texture });
          }
          resolve();
        }, undefined, () => resolve());
      });
    });

    await Promise.all(promises);
    this.assetsLoaded = true;
    this.rebuildWorld();
  }

  private rebuildWorld() {
    this.hexGroup.clear();
    this.decorGroup.clear();
    this.cityGroup.clear();

    const hexGeo = new THREE.CylinderGeometry(HEX_SIZE * SCALE_3D, HEX_SIZE * SCALE_3D, HEX_HEIGHT, 6);
    hexGeo.rotateY(Math.PI / 6); // Align to flat-top

    for (const tile of this.state.world.tiles.values()) {
      const pos = axialToPixel(tile.coord, HEX_SIZE);
      const x = pos.x * SCALE_3D;
      const z = pos.y * SCALE_3D;
      const y = tile.terrain === 'mountain' ? 10 : tile.terrain === 'hills' ? 5 : 0;

      // Base Hex
      const mat = new THREE.MeshStandardMaterial({
        map: this.textures[tile.terrain] || this.textures['plains'],
        roughness: 0.8,
      });
      if (!tile.revealed) {
        mat.map = this.textures['fog'];
        mat.color.set(0x888888);
      } else if (tile.inFog) {
        mat.color.set(0x444466);
      }

      const hex = new THREE.Mesh(hexGeo, mat);
      hex.position.set(x, y, z);
      hex.receiveShadow = true;
      hex.castShadow = true;
      this.hexGroup.add(hex);

      // Decors (Sprites/Billboards)
      if (tile.revealed) {
        this.addDecor(tile, x, y + HEX_HEIGHT/2, z);
      }
    }
  }

  private addDecor(tile: Tile, x: number, y: number, z: number) {
    if (tile.terrain === 'forest' && this.spriteMaterials['forest_sprite']) {
      const sprite = new THREE.Sprite(this.spriteMaterials['forest_sprite']);
      sprite.scale.set(40, 40, 1);
      sprite.position.set(x, y + 20, z);
      this.decorGroup.add(sprite);
    } else if (tile.terrain === 'mountain' && this.spriteMaterials['mountain_sprite']) {
      const sprite = new THREE.Sprite(this.spriteMaterials['mountain_sprite']);
      sprite.scale.set(60, 60, 1);
      sprite.position.set(x, y + 30, z);
      this.decorGroup.add(sprite);
    } else if (tile.terrain === 'hills' && this.spriteMaterials['hill_sprite']) {
      const sprite = new THREE.Sprite(this.spriteMaterials['hill_sprite']);
      sprite.scale.set(40, 30, 1);
      sprite.position.set(x, y + 15, z);
      this.decorGroup.add(sprite);
    }
  }

  private updateUnits(animTime: number) {
    this.unitGroup.clear();
    const offsets = [
      { x: 0, z: -5 },
      { x: -8, z: 2 },
      { x: 8, z: 2 },
      { x: 0, z: 8 },
    ];

    for (const unit of this.state.world.units) {
      const pos = axialToPixel(unit.coord, HEX_SIZE);
      const ux = pos.x * SCALE_3D;
      const uz = pos.y * SCALE_3D;
      
      offsets.forEach(off => {
        const geo = new THREE.SphereGeometry(4, 12, 12);
        const mat = new THREE.MeshStandardMaterial({ color: unit.color, emissive: unit.color, emissiveIntensity: 0.1 });
        const mesh = new THREE.Mesh(geo, mat);
        
        const floatY = Math.sin(animTime * 3 + ux + off.x) * 3;
        mesh.position.set(ux + off.x, 20 + floatY, uz + off.z);
        mesh.castShadow = true;
        this.unitGroup.add(mesh);
      });
    }
  }

  start() {
    this.isRunning = true;
    this.animate();
  }

  stop() {
    this.isRunning = false;
  }

  private animate() {
    if (!this.isRunning) return;
    requestAnimationFrame(() => this.animate());

    const time = performance.now() / 1000;
    this.updateUnits(time);
    
    // Smooth camera target follow (if needed)
    this.renderer.render(this.scene, this.camera);
  }

  setCamera(x: number, y: number, zoom: number) {
    this.camTarget.set(x * SCALE_3D, 0, y * SCALE_3D);
    this.zoom = zoom;
    this.camera.position.set(this.camTarget.x, 600 / zoom, this.camTarget.z + 600 / zoom);
    this.camera.lookAt(this.camTarget);
  }
}
