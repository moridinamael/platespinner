import { memo } from 'react';

function SkillLibraryCard({ skill, onInstall, installed }) {
  return (
    <div className="skill-library-card">
      <h4>{skill.name}</h4>
      <p className="skill-library-desc">{skill.description}</p>
      <div className="skill-library-meta">
        <span className="skill-library-category">{skill.category}</span>
        {skill.author && <span className="skill-library-author">{skill.author}</span>}
      </div>
      <button
        className={`btn btn-sm${installed ? '' : ' btn-primary'}`}
        onClick={() => onInstall(skill)}
        disabled={installed}
      >
        {installed ? 'Installed' : 'Install'}
      </button>
    </div>
  );
}

export default memo(SkillLibraryCard);
